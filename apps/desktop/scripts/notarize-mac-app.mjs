import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUBMISSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const DEFAULT_WAIT_MS = 180 * 60_000;
const DEFAULT_POLL_MS = 30_000;
const defaultRun = (command, args, options) =>
	execFileAsync(command, args, {
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		...options,
	});

class CommandFailure extends Error {
	constructor(operation, transient) {
		super(`[notarize-mac] ${operation} failed`);
		this.transient = transient;
	}
}

function isTransient(error) {
	const text = `${error?.code ?? ""} ${error?.stderr ?? ""} ${error?.stdout ?? ""} ${error?.message ?? ""}`;
	return (
		Boolean(error?.killed) ||
		/-1009|-1001|-1005|-1006|ECONNRESET|ETIMEDOUT|EAI_AGAIN|No network route|network connection|timed out|HTTP(?:\s+status\s+code:?)?\s+5\d\d|service unavailable/i.test(
			text,
		)
	);
}

function credentialArgs(env) {
	if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
		if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD || !env.APPLE_TEAM_ID)
			throw new Error("[notarize-mac] Incomplete Apple ID credentials");
		return [
			"--apple-id",
			env.APPLE_ID,
			"--password",
			env.APPLE_APP_SPECIFIC_PASSWORD,
			"--team-id",
			env.APPLE_TEAM_ID,
		];
	}
	if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
		if (!env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER)
			throw new Error("[notarize-mac] Incomplete App Store Connect API credentials");
		return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
	}
	if (env.APPLE_KEYCHAIN_PROFILE) {
		return [
			"--keychain-profile",
			env.APPLE_KEYCHAIN_PROFILE,
			...(env.APPLE_KEYCHAIN ? ["--keychain", env.APPLE_KEYCHAIN] : []),
		];
	}
	throw new Error("[notarize-mac] Notarization credentials are required");
}

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function stateDirectoryOutsideApp(appPath, requested) {
	let existing = resolve(requested);
	const missing = [];
	for (;;) {
		try {
			const info = await lstat(existing);
			if ((info.isSymbolicLink() && missing.length === 0) || (!info.isSymbolicLink() && !info.isDirectory()))
				throw new Error("[notarize-mac] State directory must not be a symbolic link or file");
			const parent = await realpath(existing);
			if (!(await lstat(parent)).isDirectory())
				throw new Error("[notarize-mac] State directory parent must be a directory");
			const directory = join(parent, ...missing);
			const fromApp = relative(appPath, directory);
			if (!(fromApp === ".." || fromApp.startsWith(`..${sep}`)))
				throw new Error("[notarize-mac] State directory must be outside the signed application");
			return directory;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			missing.unshift(basename(existing));
			existing = dirname(existing);
		}
	}
}

async function saveReceipt(path, receipt, exclusive = false) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		// A complete initial receipt must become visible before submit, without replacing another process's claim.
		if (exclusive) await link(temporary, path);
		else await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

async function loadReceipt(path) {
	try {
		const receipt = JSON.parse(await readFile(path, "utf8"));
		if (receipt?.schema !== 1 || !receipt.identity || typeof receipt.phase !== "string")
			throw new Error("invalid receipt");
		return receipt;
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw new Error("[notarize-mac] Existing receipt is invalid; refusing to submit again");
	}
}

async function signedIdentity(appPath, expected, invoke) {
	if (!appPath.endsWith(".app") || !(await lstat(appPath)).isDirectory())
		throw new Error("[notarize-mac] Expected an existing application bundle");
	await invoke("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], "signature verification");
	const plist = join(appPath, "Contents", "Info.plist");
	const value = async (key) =>
		(await invoke("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], "bundle metadata read")).stdout.trim();
	const bundleId = await value("CFBundleIdentifier");
	const version = await value("CFBundleShortVersionString");
	const buildVersion = await value("CFBundleVersion");
	const executable = await value("CFBundleExecutable");
	if (
		bundleId !== expected.bundleId ||
		version !== expected.version ||
		!buildVersion ||
		!executable ||
		basename(executable) !== executable ||
		executable === "." ||
		executable === ".."
	)
		throw new Error("[notarize-mac] Application identifier/version does not match the requested release");
	const architectures = (
		await invoke("lipo", ["-archs", join(appPath, "Contents", "MacOS", executable)], "architecture read")
	).stdout
		.trim()
		.split(/\s+/)
		.sort();
	const expectedArchitectures =
		expected.arch === "universal" ? ["arm64", "x86_64"] : [expected.arch === "x64" ? "x86_64" : expected.arch];
	if (JSON.stringify(architectures) !== JSON.stringify(expectedArchitectures))
		throw new Error("[notarize-mac] Application architecture differs from the requested release");
	const signatureHashes = {};
	for (const arch of architectures) {
		const result = await invoke(
			"codesign",
			["--display", "--verbose=4", "--arch", arch, appPath],
			"signature identity read",
		);
		const details = `${result.stdout}\n${result.stderr}`;
		const teamId = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim();
		const identifier = /^Identifier=(.+)$/m.exec(details)?.[1]?.trim();
		const cdhash = /^CDHash=([a-f0-9]{40})$/im.exec(details)?.[1]?.toLowerCase();
		if (!cdhash || teamId !== expected.teamId || identifier !== bundleId)
			throw new Error("[notarize-mac] Application signing identity differs from the requested release");
		signatureHashes[arch] = cdhash;
	}
	return {
		appName: basename(appPath),
		bundleId,
		version,
		buildVersion,
		teamId: expected.teamId,
		architectures,
		signatureHashes,
	};
}

function verifyAcceptedLog(log, receipt) {
	if (log?.jobId !== receipt.submissionId || log.status !== "Accepted" || !Array.isArray(log.ticketContents))
		throw new Error("[notarize-mac] Apple log does not confirm this accepted submission");
	if (receipt.archive && log.sha256 !== receipt.archive.sha256)
		throw new Error("[notarize-mac] Apple log archive hash differs from the submitted archive");
	const appPath = `${log.archiveFilename}/${receipt.identity.appName}`;
	for (const arch of receipt.identity.architectures) {
		if (
			!log.ticketContents.some(
				(ticket) =>
					ticket.path === appPath &&
					ticket.arch === arch &&
					ticket.cdhash?.toLowerCase() === receipt.identity.signatureHashes[arch],
			)
		)
			throw new Error("[notarize-mac] Accepted submission does not contain this application's signature");
	}
	return {
		submissionId: log.jobId,
		archiveFilename: log.archiveFilename,
		archiveSha256: log.sha256,
		signatureHashes: receipt.identity.signatureHashes,
	};
}

export async function notarizeMacApp({
	appPath,
	stateDir = join(dirname(appPath), "notarization"),
	expectedBundleId,
	expectedVersion,
	expectedTeamId = process.env.APPLE_TEAM_ID,
	expectedArch,
	submissionId,
	resumeOnly = false,
	env = process.env,
	run = defaultRun,
	log = (message) => console.info(message),
	now = Date.now,
	delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
	waitTimeoutMs = DEFAULT_WAIT_MS,
	pollIntervalMs = DEFAULT_POLL_MS,
	// 退避上限 60s：约 40 次重试可扛过 ~35 分钟的 runner 断网，而不是 75 秒就放弃（0.6.3 的 -1009 教训）。
	maxNetworkRetries = 40,
	platform = process.platform,
}) {
	if (platform !== "darwin") throw new Error("[notarize-mac] Notarization requires macOS");
	if (
		!expectedBundleId ||
		!/^\d+\.\d+\.\d+$/.test(expectedVersion) ||
		!expectedTeamId ||
		!["arm64", "x64", "universal"].includes(expectedArch) ||
		!Number.isFinite(waitTimeoutMs) ||
		waitTimeoutMs <= 0
	)
		throw new Error(
			"[notarize-mac] Explicit release identifier, version, team, architecture and wait budget are required",
		);
	if (submissionId && (!resumeOnly || !SUBMISSION_ID.test(submissionId)))
		throw new Error("[notarize-mac] An external submission ID requires --resume-only and a valid UUID");
	const invoke = async (command, args, operation, timeout = 120_000) => {
		try {
			return await run(command, args, { timeout });
		} catch (error) {
			// Never propagate execFile's command line: it contains Apple authentication arguments.
			throw new CommandFailure(operation, isTransient(error));
		}
	};
	appPath = await realpath(resolve(appPath));
	stateDir = await stateDirectoryOutsideApp(appPath, stateDir);
	const identity = await signedIdentity(
		appPath,
		{ bundleId: expectedBundleId, version: expectedVersion, teamId: expectedTeamId, arch: expectedArch },
		invoke,
	);
	await mkdir(stateDir, { recursive: true });
	const receiptPath = join(stateDir, "receipt.json");
	let receipt = await loadReceipt(receiptPath);
	if (receipt && JSON.stringify(receipt.identity) !== JSON.stringify(identity))
		throw new Error("[notarize-mac] Receipt does not match this signed application; refusing to submit");
	if (receipt?.submissionId && submissionId && receipt.submissionId !== submissionId)
		throw new Error("[notarize-mac] Supplied submission ID differs from the saved receipt");
	if (receipt?.phase === "rejected")
		throw new Error("[notarize-mac] This submission was rejected; do not resubmit unchanged bytes");
	const auth = credentialArgs(env);
	if (submissionId && !receipt?.submissionId) {
		receipt = { ...receipt, schema: 1, identity, phase: "submitted", submissionId, imported: !receipt?.archive };
		await saveReceipt(receiptPath, receipt, !(await loadReceipt(receiptPath)));
	} else if (!receipt) {
		if (resumeOnly) throw new Error("[notarize-mac] Resume requires an existing receipt or explicit submission ID");
		const file = `${basename(appPath, ".app")}-${identity.version}-${randomUUID()}.zip`;
		const archivePath = join(stateDir, file);
		await invoke(
			"ditto",
			["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archivePath],
			"notarization archive creation",
			20 * 60_000,
		);
		receipt = { schema: 1, identity, phase: "submitting", archive: { file, sha256: await sha256(archivePath) } };
		await saveReceipt(receiptPath, receipt, true);
		try {
			const result = await invoke(
				"xcrun",
				["notarytool", "submit", archivePath, ...auth, "--no-wait", "--output-format", "json"],
				"notarytool submit",
				20 * 60_000,
			);
			const response = JSON.parse(result.stdout);
			if (!SUBMISSION_ID.test(response.id)) throw new Error("Missing submission ID");
			receipt = { ...receipt, phase: "submitted", submissionId: response.id };
			await saveReceipt(receiptPath, receipt);
		} catch {
			// A failed response can still mean Apple accepted the upload. Never automatically submit again.
			receipt = { ...receipt, phase: "needs-review" };
			await saveReceipt(receiptPath, receipt);
			throw new Error(
				"[notarize-mac] Submit outcome is uncertain. Preserve receipt/archive and resolve the original submission ID; no automatic resubmission",
			);
		}
	}
	if (!SUBMISSION_ID.test(receipt.submissionId ?? ""))
		throw new Error(
			"[notarize-mac] Receipt has an unresolved submit attempt; resolve its original ID before resuming",
		);
	log(`[notarize-mac] Submission ${receipt.submissionId} recorded; waiting on the original ID`);
	const deadline = now() + waitTimeoutMs;
	const pending = () =>
		new Error(
			`[notarize-mac] Submission ${receipt.submissionId} remains pending; resume with this receipt, never submit again`,
		);
	const query = async (operation) => {
		for (let failures = 0; ; failures++) {
			if (now() >= deadline) throw pending();
			try {
				const result = await invoke(
					"xcrun",
					["notarytool", operation, receipt.submissionId, ...auth, "--output-format", "json"],
					`notarytool ${operation}`,
					Math.min(120_000, deadline - now()),
				);
				try {
					return JSON.parse(result.stdout);
				} catch {
					throw new CommandFailure(`notarytool ${operation} response parsing`, true);
				}
			} catch (error) {
				if (!error.transient) throw error;
				if (failures >= maxNetworkRetries) throw pending();
				log(
					`[notarize-mac] Submission ${receipt.submissionId}: retrying ${operation} after a transient error (${failures + 1}/${maxNetworkRetries})`,
				);
				await delay(Math.min(5_000 * 2 ** failures, 60_000, Math.max(0, deadline - now())));
			}
		}
	};
	let lastStatus;
	for (;;) {
		const info = await query("info");
		if (info.id !== receipt.submissionId) throw new Error("[notarize-mac] Apple returned a different submission ID");
		if (lastStatus !== info.status) {
			const status = ["Accepted", "In Progress", "Invalid", "Rejected"].includes(info.status)
				? info.status
				: "unknown status";
			log(`[notarize-mac] Submission ${receipt.submissionId}: ${status}`);
			lastStatus = info.status;
		}
		if (info.status === "Accepted") break;
		if (["Invalid", "Rejected"].includes(info.status)) {
			receipt = { ...receipt, phase: "rejected", status: info.status };
			await saveReceipt(receiptPath, receipt);
			throw new Error(`[notarize-mac] Apple ${info.status.toLowerCase()} submission ${receipt.submissionId}`);
		}
		if (info.status !== "In Progress") throw new Error("[notarize-mac] Unexpected Apple submission status");
		await delay(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
	}
	const acceptance = verifyAcceptedLog(await query("log"), receipt);
	receipt = { ...receipt, phase: "accepted", acceptance };
	await saveReceipt(receiptPath, receipt);
	await invoke("xcrun", ["stapler", "staple", "-v", appPath], "ticket stapling", 5 * 60_000);
	await invoke(
		"codesign",
		["--verify", "--deep", "--strict", "--verbose=2", appPath],
		"post-staple signature verification",
	);
	await invoke("xcrun", ["stapler", "validate", "-v", appPath], "ticket validation");
	receipt = { ...receipt, phase: "stapled" };
	await saveReceipt(receiptPath, receipt);
	return receipt;
}

export default async function afterSign(context, notarize = notarizeMacApp) {
	if (context.electronPlatformName !== "darwin") return;
	const arch = { 0: "ia32", 1: "x64", 3: "arm64", 4: "universal" }[context.arch];
	await notarize({
		appPath: join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
		stateDir: join(context.appOutDir, "notarization"),
		expectedBundleId: context.packager.appInfo.id,
		expectedVersion: context.packager.appInfo.version,
		expectedArch: arch,
	});
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
	const { values } = parseArgs({
		args,
		options: {
			app: { type: "string" },
			"state-dir": { type: "string" },
			"submission-id": { type: "string" },
			"resume-only": { type: "boolean", default: false },
			"expected-bundle-id": { type: "string" },
			"expected-version": { type: "string" },
			"expected-team-id": { type: "string" },
			"expected-arch": { type: "string" },
			"timeout-seconds": { type: "string" },
		},
	});
	if (!values.app || !values["state-dir"]) throw new Error("[notarize-mac] --app and --state-dir are required");
	return notarizeMacApp({
		...dependencies,
		appPath: values.app,
		stateDir: values["state-dir"],
		submissionId: values["submission-id"],
		resumeOnly: values["resume-only"],
		expectedBundleId: values["expected-bundle-id"],
		expectedVersion: values["expected-version"],
		expectedTeamId: values["expected-team-id"] ?? dependencies.env?.APPLE_TEAM_ID ?? process.env.APPLE_TEAM_ID,
		expectedArch: values["expected-arch"],
		waitTimeoutMs:
			values["timeout-seconds"] === undefined ? DEFAULT_WAIT_MS : Number(values["timeout-seconds"]) * 1000,
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
