import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import afterSign, { main, notarizeMacApp } from "./notarize-mac-app.mjs";

const id = "11111111-2222-4333-8444-555555555555";
const signature = "a".repeat(40);
const env = {
	APPLE_TEAM_ID: "TEAM123456",
	APPLE_API_KEY: "/fixture/private-key.p8",
	APPLE_API_KEY_ID: "secret-key-id",
	APPLE_API_ISSUER: "secret-issuer",
};

async function fixture(context, settings = {}) {
	const root = await mkdtemp(join(tmpdir(), "mac-notary-test-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const appPath = join(root, "release", "mac-arm64", "Example.app");
	await mkdir(appPath, { recursive: true });
	const calls = [];
	let clock = 0;
	let submittedArchive;
	let stapled = false;
	const infoResults = [...(settings.infoResults ?? ["Accepted"])];
	const logResults = [...(settings.logResults ?? [])];
	const run = async (command, args, options) => {
		calls.push({ command, args, options });
		assert.ok(options.timeout > 0, "every process has a timeout");
		if (command === "codesign") {
			if (args[0] === "--verify") {
				if (stapled && settings.failPostSignature) throw new Error("post-staple signature failure");
				assert.ok(args.includes("--strict") && args.includes("--deep"));
				return { stdout: "", stderr: "" };
			}
			return {
				stdout: "",
				stderr: `Identifier=com.example.desktop\nTeamIdentifier=TEAM123456\nCDHash=${settings.signature ?? signature}\n`,
			};
		}
		if (command === "/usr/libexec/PlistBuddy") {
			const values = {
				CFBundleIdentifier: "com.example.desktop",
				CFBundleShortVersionString: "0.6.3",
				CFBundleVersion: "0.6.3",
				CFBundleExecutable: "Example",
			};
			return { stdout: `${values[args[1].slice("Print :".length)]}\n`, stderr: "" };
		}
		if (command === "lipo") return { stdout: "arm64\n", stderr: "" };
		if (command === "ditto") {
			await writeFile(args.at(-1), "immutable signed application archive");
			return { stdout: "", stderr: "" };
		}
		assert.equal(command, "xcrun");
		if (args[0] === "notarytool") {
			if (args[1] === "submit") {
				submittedArchive = args[2];
				assert.ok(args.includes("--no-wait"));
				assert.ok(!args.includes("--wait"));
				const receipt = JSON.parse(await readFile(join(root, "state", "receipt.json"), "utf8"));
				assert.equal(receipt.phase, "submitting", "claim is durable before starting upload");
				if (settings.submitError) throw settings.submitError;
				return { stdout: settings.submitOutput ?? JSON.stringify({ id, status: "In Progress" }), stderr: "" };
			}
			assert.equal(args[2], id, "all status/log queries retain the original submission");
			if (args[1] === "info") {
				const response = infoResults.shift() ?? "Accepted";
				if (response instanceof Error) throw response;
				return { stdout: JSON.stringify({ id, status: response }), stderr: "" };
			}
			assert.equal(args[1], "log");
			const failure = logResults.shift();
			if (failure) throw failure;
			const archiveFilename = submittedArchive ? basename(submittedArchive) : "Original.zip";
			const sha256 = submittedArchive
				? createHash("sha256")
						.update(await readFile(submittedArchive))
						.digest("hex")
				: "legacy-archive-hash";
			return {
				stdout: JSON.stringify({
					jobId: id,
					status: "Accepted",
					archiveFilename,
					sha256: settings.archiveSha256 ?? sha256,
					ticketContents: [
						{
							path: `${archiveFilename}/Example.app`,
							arch: "arm64",
							cdhash: settings.ticketSignature ?? signature,
						},
					],
				}),
				stderr: "",
			};
		}
		assert.equal(args[0], "stapler");
		if (args[1] === "staple") {
			if (settings.failStaple) throw new Error("staple failed");
			stapled = true;
		} else {
			assert.equal(args[1], "validate");
			if (settings.failValidate) throw new Error("ticket validation failed");
		}
		return { stdout: "", stderr: "" };
	};
	const options = {
		appPath,
		stateDir: join(root, "state"),
		expectedBundleId: "com.example.desktop",
		expectedVersion: "0.6.3",
		expectedTeamId: env.APPLE_TEAM_ID,
		expectedArch: "arm64",
		env,
		run,
		log: () => {},
		platform: "darwin",
		now: () => clock,
		delay: async (milliseconds) => {
			clock += milliseconds;
		},
		waitTimeoutMs: 300_000,
		pollIntervalMs: 30,
	};
	return {
		root,
		options,
		settings,
		calls,
		infoResults,
		receipt: async () => JSON.parse(await readFile(join(root, "state", "receipt.json"), "utf8")),
	};
}

function submitCalls(f) {
	return f.calls.filter(({ command, args }) => command === "xcrun" && args[1] === "submit");
}
function transientError() {
	return Object.assign(new Error("command included secret-key-id and secret-issuer"), {
		stderr: "NSURLErrorDomain Code=-1009 No network route",
	});
}

test("submits once, survives a status network failure, and verifies Apple's matching ticket before stapling", async (context) => {
	const f = await fixture(context, { infoResults: [transientError(), "In Progress", "Accepted"] });
	const receipt = await notarizeMacApp(f.options);
	assert.equal(receipt.phase, "stapled");
	assert.equal(receipt.submissionId, id);
	assert.equal(submitCalls(f).length, 1);
	assert.equal(f.calls.filter(({ args }) => args[1] === "info").length, 3);
	assert.equal(f.calls.at(-1).args[1], "validate");
	assert.equal((await f.receipt()).phase, "stapled");
	assert.ok(!(await readFile(join(f.options.stateDir, "receipt.json"), "utf8")).includes("secret-"));
});

test("a later execution resumes a pending receipt without zipping, signing or submitting again", async (context) => {
	const f = await fixture(context, { infoResults: ["In Progress", "Accepted"] });
	await assert.rejects(notarizeMacApp({ ...f.options, waitTimeoutMs: 30 }), /remains pending/);
	assert.equal((await f.receipt()).submissionId, id);
	const before = f.calls.length;
	assert.equal((await notarizeMacApp({ ...f.options, resumeOnly: true })).phase, "stapled");
	assert.equal(submitCalls(f).length, 1);
	assert.ok(
		f.calls
			.slice(before)
			.every(({ command, args }) => command !== "ditto" && args[1] !== "submit" && !args.includes("--sign")),
	);
});

test("network retries are finite and leave the same submission resumable", async (context) => {
	const f = await fixture(context, { infoResults: [transientError(), transientError(), transientError()] });
	const error = await notarizeMacApp({ ...f.options, maxNetworkRetries: 1 }).catch((failure) => failure);
	assert.match(error.message, /remains pending/);
	assert.ok(!error.message.includes("secret-"));
	assert.equal(submitCalls(f).length, 1);
	assert.equal(f.calls.filter(({ args }) => args[1] === "info").length, 2);
	assert.equal((await f.receipt()).phase, "submitted");
});

for (const submitOutput of [undefined, "non-JSON response"]) {
	test(`an ambiguous submit response cannot cause another upload (${submitOutput ?? "network failure"})`, async (context) => {
		const f = await fixture(context, submitOutput ? { submitOutput } : { submitError: transientError() });
		await assert.rejects(notarizeMacApp(f.options), /outcome is uncertain/);
		assert.equal((await f.receipt()).phase, "needs-review");
		await assert.rejects(notarizeMacApp(f.options), /unresolved submit attempt/);
		assert.equal(submitCalls(f).length, 1);
	});
}

test("Apple HTTP status code 500 and 502 responses retry info and log without a new submission", async (context) => {
	const failure = (status) =>
		Object.assign(new Error("notarytool failed"), {
			stderr: `Error: HTTP status code: ${status}. ${status === 500 ? "Internal server error" : "Bad Gateway"}`,
		});
	const f = await fixture(context, { infoResults: [failure(500), "Accepted"], logResults: [failure(502)] });
	assert.equal((await notarizeMacApp(f.options)).phase, "stapled");
	assert.equal(submitCalls(f).length, 1);
	for (const operation of ["info", "log"]) assert.equal(f.calls.filter(({ args }) => args[1] === operation).length, 2);
});

test("state directories inside the signed app are refused before creating files or running commands", async (context) => {
	const f = await fixture(context);
	for (const name of ["notarization", "..notarization"]) {
		const stateDir = join(f.options.appPath, name);
		await assert.rejects(notarizeMacApp({ ...f.options, stateDir }), /outside the signed application/);
		await assert.rejects(stat(stateDir), { code: "ENOENT" });
	}
	assert.equal(f.calls.length, 0);
});

test("a state-directory symlink cannot redirect writes into the signed app", async (context) => {
	const f = await fixture(context);
	const stateDir = join(f.root, "state-link");
	await symlink(f.options.appPath, stateDir, "dir");
	await assert.rejects(notarizeMacApp({ ...f.options, stateDir }), /symbolic link/);
	assert.equal(f.calls.length, 0);
	await assert.rejects(stat(join(f.options.appPath, "receipt.json")), { code: "ENOENT" });
});

test("an existing parent alias is resolved safely when the state directory remains outside the app", async (context) => {
	const f = await fixture(context);
	const parent = join(f.root, "parent-alias");
	await symlink(f.root, parent, "dir");
	const result = await notarizeMacApp({ ...f.options, stateDir: join(parent, "state") });
	assert.equal(result.phase, "stapled");
	assert.equal((await f.receipt()).submissionId, id);
});

test("a valid but different signed application cannot reuse a saved receipt", async (context) => {
	const f = await fixture(context, { infoResults: ["In Progress"] });
	await assert.rejects(notarizeMacApp({ ...f.options, waitTimeoutMs: 30 }), /remains pending/);
	f.settings.signature = "b".repeat(40);
	const before = f.calls.length;
	await assert.rejects(notarizeMacApp(f.options), /Receipt does not match/);
	assert.ok(f.calls.slice(before).every(({ command }) => command !== "xcrun"));
});

test("explicit recovery of an uncertain submit retains the original archive hash binding", async (context) => {
	const f = await fixture(context, { submitError: transientError() });
	await assert.rejects(notarizeMacApp(f.options), /outcome is uncertain/);
	const originalArchive = (await f.receipt()).archive;
	const receipt = await notarizeMacApp({ ...f.options, submissionId: id, resumeOnly: true });
	assert.deepEqual(receipt.archive, originalArchive);
	assert.equal(receipt.acceptance.archiveSha256, originalArchive.sha256);
	assert.equal(receipt.phase, "stapled");
	assert.equal(submitCalls(f).length, 1);
});

test("an Accepted log for different uploaded bytes is rejected before stapling", async (context) => {
	const f = await fixture(context, { archiveSha256: "0".repeat(64) });
	await assert.rejects(notarizeMacApp(f.options), /archive hash differs/);
	assert.ok(f.calls.every(({ args }) => args[0] !== "stapler"));
});

test("concurrent executions cannot upload the signed application twice", async (context) => {
	const f = await fixture(context);
	const results = await Promise.allSettled([notarizeMacApp(f.options), notarizeMacApp(f.options)]);
	assert.ok(results.some((result) => result.status === "fulfilled"));
	assert.equal(submitCalls(f).length, 1);
});

for (const status of ["Invalid", "Rejected"]) {
	test(`${status} fails permanently without stapling or another submission`, async (context) => {
		const f = await fixture(context, { infoResults: [status] });
		await assert.rejects(notarizeMacApp(f.options), new RegExp(status.toLowerCase()));
		assert.equal((await f.receipt()).phase, "rejected");
		await assert.rejects(notarizeMacApp(f.options), /was rejected/);
		assert.equal(submitCalls(f).length, 1);
		assert.ok(f.calls.every(({ args }) => args[0] !== "stapler"));
	});
}

for (const failure of ["failStaple", "failValidate", "failPostSignature"]) {
	test(`${failure} cannot produce a completed receipt and can resume the original submission`, async (context) => {
		const f = await fixture(context, { [failure]: true });
		await assert.rejects(notarizeMacApp(f.options), /failed/);
		assert.equal((await f.receipt()).phase, "accepted");
		f.settings[failure] = false;
		assert.equal((await notarizeMacApp({ ...f.options, resumeOnly: true })).phase, "stapled");
		assert.equal(submitCalls(f).length, 1);
	});
}

test("the CLI restores an external ID without any submit and rejects another app's Accepted ticket", async (context) => {
	for (const matching of [false, true]) {
		const f = await fixture(context, { ticketSignature: matching ? signature : "b".repeat(40) });
		const args = [
			"--app",
			f.options.appPath,
			"--state-dir",
			f.options.stateDir,
			"--submission-id",
			id,
			"--resume-only",
			"--expected-bundle-id",
			"com.example.desktop",
			"--expected-version",
			"0.6.3",
			"--expected-arch",
			"arm64",
		];
		if (matching) assert.equal((await main(args, f.options)).phase, "stapled");
		else {
			await assert.rejects(main(args, f.options), /does not contain this application's signature/);
			assert.ok(f.calls.every(({ args: commandArgs }) => commandArgs[0] !== "stapler"));
		}
		assert.equal(submitCalls(f).length, 0);
		assert.ok(f.calls.every(({ command }) => command !== "ditto"));
	}
});

test("external submission IDs are accepted only by resume-only mode", async (context) => {
	const f = await fixture(context);
	await assert.rejects(notarizeMacApp({ ...f.options, submissionId: id }), /requires --resume-only/);
	assert.equal(f.calls.length, 0);
});

test("a conflicting recovery ID cannot replace the receipt's original submission", async (context) => {
	const f = await fixture(context, { infoResults: ["In Progress"] });
	await assert.rejects(notarizeMacApp({ ...f.options, waitTimeoutMs: 30 }), /remains pending/);
	await assert.rejects(
		notarizeMacApp({ ...f.options, resumeOnly: true, submissionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
		/differs from the saved receipt/,
	);
	assert.equal((await f.receipt()).submissionId, id);
	assert.equal(submitCalls(f).length, 1);
});

test("the hook ignores non-macOS builds and required signing keeps one explicit notarization hook", async () => {
	await afterSign({ electronPlatformName: "win32" });
	let request;
	await afterSign(
		{
			electronPlatformName: "darwin",
			arch: 3,
			appOutDir: "/fixture/release/mac-arm64",
			packager: { appInfo: { productFilename: "Another Product", id: "org.other.product", version: "1.2.3" } },
		},
		async (options) => {
			request = options;
		},
	);
	assert.equal(request.appPath, "/fixture/release/mac-arm64/Another Product.app");
	assert.equal(request.expectedBundleId, "org.other.product");
	assert.equal(request.expectedVersion, "1.2.3");
	assert.equal(request.expectedArch, "arm64");
	const source = await readFile(new URL("./prepare-pack.js", import.meta.url), "utf8");
	assert.match(
		source,
		/macSigning\.enabled && macSigning\.notarize\s*\? \{ afterSign: join\(projectRoot, "scripts", "notarize-mac-app\.mjs"\) \}/,
	);
	assert.equal((source.match(/afterSign:/g) ?? []).length, 1);
});
