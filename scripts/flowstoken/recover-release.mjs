import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertTag, githubJson } from "./publish-release.mjs";
import { checkpoint, digest } from "./release-artifacts.mjs";
import {
	buildRecoveryPlan,
	originalSubmissionFromLog,
	RECOVERY_PLATFORMS,
	recoveryPlanDigest,
	SOURCE_CONFIG_FILES,
	VERIFICATION_HARNESS_INPUTS,
	validateRecoveryPlan,
	verifyRecoveryPlanOnline,
} from "./release-recovery-identity.mjs";

function run(file, args, options = {}) {
	return execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

export function stageController(
	destination,
	{ sourceRoot = process.cwd(), controllerSha = process.env.GITHUB_SHA, envFile = process.env.GITHUB_ENV } = {},
) {
	if (
		!/^[a-f\d]{40}$/.test(controllerSha) ||
		run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot }).trim() !== controllerSha
	)
		throw new Error("Controller checkout differs from the workflow commit");
	run("git", ["diff", "--exit-code", "HEAD", "--", ...VERIFICATION_HARNESS_INPUTS], { cwd: sourceRoot });
	const files = run("git", ["ls-files", "-z", "--", ...VERIFICATION_HARNESS_INPUTS], { cwd: sourceRoot })
		.split("\0")
		.filter(Boolean)
		.sort();
	if (!files.includes("apps/desktop/wdio.conf.ts") || !files.some((file) => file.endsWith(".e2e.ts")))
		throw new Error("Controller verification harness is incomplete");
	for (const file of files)
		if (!lstatSync(join(sourceRoot, file)).isFile())
			throw new Error(`Verification tool must be a regular tracked file: ${file}`);
	for (const name of [
		"scripts/flowstoken",
		"scripts/release",
		"apps/desktop/scripts",
		"apps/desktop/package.json",
		"apps/desktop/wdio.conf.ts",
		"apps/desktop/e2e",
		"branding/flowstoken",
		".github/workflows",
	])
		cpSync(join(sourceRoot, name), join(destination, name), { recursive: true });
	const manifest = {
		schema: 1,
		controllerSha,
		files: files.map((file) => {
			const body = readFileSync(join(destination, file));
			return { path: file, size: body.length, sha256: createHash("sha256").update(body).digest("hex") };
		}),
	};
	writeFileSync(join(destination, "controller-verification.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	appendFileSync(envFile, `VETTA_RELEASE_CONTROLLER_DIR=${destination}\nVETTA_RELEASE_SOURCE_ROOT=${sourceRoot}\n`);
	return manifest;
}

export function assertSourceCheckout(plan, sourceRoot) {
	validateRecoveryPlan(plan);
	if (run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot }).trim() !== plan.source.sha)
		throw new Error("Recovery checkout is not the original source commit");
	run("git", ["diff", "--exit-code", "HEAD", "--", ...SOURCE_CONFIG_FILES], { cwd: sourceRoot });
	for (const file of SOURCE_CONFIG_FILES) {
		const actual = createHash("sha256")
			.update(run("git", ["show", `HEAD:${file}`], { cwd: sourceRoot }))
			.digest("hex");
		if (actual !== plan.source.configHashes[file]) throw new Error(`Original source configuration changed: ${file}`);
	}
}

function appendOutputs(values) {
	for (const [key, value] of Object.entries(values)) {
		if (String(value).includes("\n")) throw new Error("Invalid multiline recovery output");
		appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
	}
}

export const SAFE_ARCHIVE_CHECK = `
import os,sys,tarfile,zipfile
archive,out,member=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
 if z.namelist()!=[member]: raise RuntimeError('Unexpected artifact ZIP members')
 z.extract(member,out)
if member.endswith('.tar'):
 with tarfile.open(os.path.join(out,member)) as t:
  for item in t:
   if item.name != 'release' and not item.name.startswith('release/'): raise RuntimeError('Archive escaped release root')
   tarfile.data_filter(item,out)
`;

export function nativeTarInvocation(
	archive,
	destination,
	{ platform = process.platform, environment = process.env, exists = existsSync } = {},
) {
	let file = platform === "darwin" ? "/usr/bin/tar" : "tar";
	if (platform === "win32") {
		const windows = environment.SystemRoot ?? environment.SYSTEMROOT;
		if (typeof windows !== "string" || !win32.isAbsolute(windows))
			throw new Error("Windows SystemRoot is unavailable");
		file = win32.join(windows, "System32", "tar.exe");
		if (!exists(file)) throw new Error("Native Windows bsdtar is unavailable; refusing Git tar with Windows paths");
	}
	return { file, args: ["-xf", archive, "-C", destination] };
}

async function downloadArtifact(repo, artifact, directory, member) {
	mkdirSync(directory, { recursive: true });
	const zip = join(directory, "artifact.zip");
	const fd = openSync(zip, "wx");
	try {
		run("gh", ["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`], { stdio: ["ignore", fd, "inherit"] });
	} finally {
		closeSync(fd);
	}
	if ((await stat(zip)).size !== artifact.size || `sha256:${await digest(zip)}` !== artifact.digest)
		throw new Error("Downloaded artifact size/digest does not match GitHub's immutable artifact");
	run(process.env.RECOVERY_PYTHON ?? "python", ["-c", SAFE_ARCHIVE_CHECK, zip, directory, member]);
	if (member.endsWith(".tar")) {
		// Native macOS bsdtar merges AppleDouble metadata. Python extraction corrupts signed bundle contents.
		const tar = nativeTarInvocation(join(directory, member), directory);
		run(tar.file, tar.args);
	}
}

async function planRecovery(output) {
	const repo = process.env.GITHUB_REPOSITORY;
	const controllerSha = process.env.GITHUB_SHA;
	const sourceRunId = process.env.RECOVERY_SOURCE_RUN ?? "";
	if (
		!/^[\w.-]+\/[\w.-]+$/.test(repo) ||
		!/^[a-f\d]{40}$/.test(controllerSha) ||
		!/^\d+$/.test(process.env.GITHUB_RUN_ID)
	)
		throw new Error("Missing controller repository, SHA or run identity");
	if (!sourceRunId) {
		if (
			process.env.RECOVERY_SOURCE_SHA ||
			process.env.RECOVERY_SOURCE_ATTEMPT ||
			process.env.RECOVERY_ARM64_SUBMISSION ||
			process.env.RECOVERY_X64_SUBMISSION
		)
			throw new Error("Incomplete recovery inputs");
		appendOutputs({
			recovery: "false",
			source_sha: controllerSha,
			controller_sha: controllerSha,
			source_version: JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version,
		});
		return;
	}
	const sourceSha = process.env.RECOVERY_SOURCE_SHA;
	const sourceAttempt = Number(process.env.RECOVERY_SOURCE_ATTEMPT);
	if (
		!/^\d+$/.test(sourceRunId) ||
		!/^[a-f\d]{40}$/.test(sourceSha) ||
		!Number.isSafeInteger(sourceAttempt) ||
		sourceAttempt < 1
	)
		throw new Error("Recovery requires an exact original run, attempt and source SHA");
	const sourceRun = await githubJson(`repos/${repo}/actions/runs/${sourceRunId}`);
	const { jobs } = await githubJson(
		`repos/${repo}/actions/runs/${sourceRunId}/attempts/${sourceAttempt}/jobs?per_page=100`,
	);
	const listed = await githubJson(`repos/${repo}/actions/runs/${sourceRunId}/artifacts?per_page=100`);
	if (listed.total_count > 100) throw new Error("Original artifact list requires manual review");
	try {
		run("git", ["cat-file", "-e", `${sourceSha}^{commit}`]);
	} catch {
		run("git", ["fetch", "--no-tags", "origin", sourceSha]);
	}
	const sourceFile = (name) => run("git", ["show", `${sourceSha}:${name}`]);
	const version = JSON.parse(sourceFile("apps/desktop/package.json")).version;
	const configHashes = Object.fromEntries(
		SOURCE_CONFIG_FILES.map((name) => [name, createHash("sha256").update(sourceFile(name)).digest("hex")]),
	);
	const submissions = {
		"macos-arm64": process.env.RECOVERY_ARM64_SUBMISSION,
		"macos-x64": process.env.RECOVERY_X64_SUBMISSION,
	};
	const submissionIdsByJob = {};
	for (const job of jobs) {
		const platform = job.name?.replace(/^build /, "");
		if (["macos-arm64", "macos-x64"].includes(platform) && job.conclusion !== "success") {
			const log = run("gh", ["api", `repos/${repo}/actions/jobs/${job.id}/logs`]);
			submissionIdsByJob[job.id] = originalSubmissionFromLog(log, submissions[platform]);
		}
	}
	const plan = buildRecoveryPlan({
		repo,
		controllerSha,
		recoveryRun: process.env.GITHUB_RUN_ID,
		sourceSha,
		sourceAttempt,
		version,
		configHashes,
		sourceRun,
		jobs,
		artifacts: listed.artifacts,
		submissions,
		submissionIdsByJob,
	});
	assertTag(`v${version}`, sourceSha);
	await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`);
	appendOutputs({
		recovery: "true",
		source_sha: sourceSha,
		controller_sha: controllerSha,
		source_version: version,
		plan_digest: recoveryPlanDigest(plan),
	});
}

export async function restorePlatform(
	plan,
	platform,
	sourceRoot,
	controllerRoot,
	workDir,
	{ api = githubJson, download = downloadArtifact, execute = run, environment = process.env } = {},
) {
	validateRecoveryPlan(plan, { controllerSha: environment.GITHUB_SHA, recoveryRun: environment.GITHUB_RUN_ID });
	if (!RECOVERY_PLATFORMS.includes(platform)) throw new Error("Unknown recovery platform");
	assertSourceCheckout(plan, sourceRoot);
	await verifyRecoveryPlanOnline(plan, api);
	const original = plan.platforms[platform];
	const extracted = await mkdtemp(join(workDir, `${platform}-`));
	await download(
		plan.repo,
		original.artifact,
		extracted,
		original.mode === "checkpoint" ? "release-build.tar" : "failed-macos.tar",
	);
	const destination = join(sourceRoot, "apps/desktop/release");
	let notarization;
	let packaging;
	if (original.mode === "checkpoint") {
		const release = join(extracted, "release");
		if ((await readFile(join(release, "release-publish.txt"), "utf8")).trim() !== "false")
			throw new Error("Original checkpoint came from a publishing run");
		if (
			platform.startsWith("macos-") &&
			(await readFile(join(release, "require-mac-signature.txt"), "utf8")).trim() !== "1"
		)
			throw new Error("Original Mac checkpoint was not strictly verified");
		await checkpoint(
			release,
			{
				sha: plan.source.sha,
				run: plan.source.run,
				attempt: plan.source.attempt,
				version: plan.source.version,
				platform,
			},
			true,
		);
		if (platform.startsWith("macos-")) await execute("/usr/bin/ditto", [release, destination]);
		else
			cpSync(release, destination, {
				recursive: true,
				errorOnExist: true,
				force: false,
				verbatimSymlinks: true,
				preserveTimestamps: true,
			});
	} else {
		const arch = platform.slice("macos-".length);
		const signatureArch = arch === "x64" ? "x86_64" : arch;
		const app = join(extracted, "release", arch === "arm64" ? "mac-arm64" : "mac", "FlowsToken.app");
		const state = join(extracted, "notarization-state");
		const env = { ...environment };
		for (const key of Object.keys(env)) if (key.startsWith("CSC_")) delete env[key];
		await execute(
			process.execPath,
			[
				join(controllerRoot, "apps/desktop/scripts/notarize-mac-app.mjs"),
				"--app",
				app,
				"--state-dir",
				state,
				"--submission-id",
				original.submissionId,
				"--resume-only",
				"--expected-bundle-id",
				"com.flowstoken.desktop",
				"--expected-version",
				plan.source.version,
				"--expected-arch",
				arch,
				"--timeout-seconds",
				"1200",
			],
			{ stdio: "inherit", env },
		);
		const receipt = JSON.parse(await readFile(join(state, "receipt.json"), "utf8"));
		notarization = {
			schema: receipt.schema,
			submissionId: receipt.submissionId,
			phase: receipt.phase,
			identity: receipt.identity,
			acceptance: receipt.acceptance,
		};
		if (
			notarization.schema !== 1 ||
			notarization.phase !== "stapled" ||
			notarization.acceptance?.submissionId !== original.submissionId ||
			notarization.submissionId !== original.submissionId
		)
			throw new Error("Notarization receipt refers to a different original request");
		await execute(
			process.execPath,
			[
				join(controllerRoot, "apps/desktop/scripts/repackage-notarized-mac.mjs"),
				"--app",
				app,
				"--source-root",
				sourceRoot,
				"--source-sha",
				plan.source.sha,
				"--output",
				destination,
				"--arch",
				arch,
			],
			{ stdio: "inherit", env },
		);
		packaging = JSON.parse(await readFile(join(destination, "recovery-repackage.json"), "utf8"));
		if (
			packaging.schema !== 1 ||
			packaging.sourceSha !== plan.source.sha ||
			packaging.version !== plan.source.version ||
			packaging.appId !== "com.flowstoken.desktop" ||
			packaging.arch !== arch ||
			packaging.cdhash !== notarization.identity?.signatureHashes?.[signatureArch] ||
			packaging.teamId !== notarization.identity?.teamId ||
			packaging.checkpointApp !== (arch === "arm64" ? "mac-arm64/FlowsToken.app" : "mac/FlowsToken.app")
		)
			throw new Error("Recovered Mac containers do not match the original signed application");
	}
	await writeFile(
		join(destination, "recovery-result.json"),
		`${JSON.stringify({ planDigest: recoveryPlanDigest(plan), origin: original, ...(notarization ? { notarization, packaging } : {}) }, null, 2)}\n`,
	);
}

async function loadPlan(repo, runId, controllerSha, sourceSha, originRun, originAttempt, output) {
	const current = await githubJson(`repos/${repo}/actions/runs/${runId}`);
	if (
		current.head_sha !== controllerSha ||
		current.event !== "workflow_dispatch" ||
		current.path !== ".github/workflows/desktop-release.yml"
	)
		throw new Error("Recovery run controller differs from the current workflow");
	const list = await githubJson(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
	const artifacts = list.artifacts.filter(
		(artifact) => artifact.name === "release-recovery-plan" && !artifact.expired,
	);
	if (artifacts.length !== 1 || list.total_count > 100) throw new Error("Missing or ambiguous recovery plan artifact");
	const artifact = artifacts[0];
	if (String(artifact.workflow_run?.id) !== runId || artifact.workflow_run?.head_sha !== controllerSha)
		throw new Error("Recovery plan artifact has a different controller");
	const directory = await mkdtemp(join(tmpdir(), "release-recovery-plan-"));
	await downloadArtifact(
		repo,
		{ id: artifact.id, size: artifact.size_in_bytes, digest: artifact.digest },
		directory,
		"recovery-plan.json",
	);
	const plan = JSON.parse(await readFile(join(directory, "recovery-plan.json"), "utf8"));
	validateRecoveryPlan(plan, {
		repo,
		recoveryRun: runId,
		controllerSha,
		"source.sha": sourceSha,
		"source.run": originRun,
		"source.attempt": Number(originAttempt),
	});
	await verifyRecoveryPlanOnline(plan, githubJson);
	await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`);
}

async function main() {
	const { values } = parseArgs({
		options: Object.fromEntries(
			[
				"mode",
				"out",
				"plan",
				"platform",
				"source-root",
				"controller-root",
				"work-dir",
				"repo",
				"run",
				"controller-sha",
				"source-sha",
				"origin-run",
				"origin-attempt",
			].map((key) => [key, { type: "string" }]),
		),
	});
	if (values.mode === "plan") return planRecovery(values.out);
	if (values.mode === "stage") {
		const destination = resolve(values.out);
		stageController(destination);
		return;
	}
	if (values.mode === "load-plan")
		return loadPlan(
			values.repo,
			values.run,
			values["controller-sha"],
			values["source-sha"],
			values["origin-run"],
			values["origin-attempt"],
			values.out,
		);
	const plan = JSON.parse(await readFile(values.plan, "utf8"));
	if (values.mode === "check-source") return assertSourceCheckout(plan, values["source-root"]);
	if (values.mode === "restore")
		return restorePlatform(
			plan,
			values.platform,
			values["source-root"],
			values["controller-root"],
			values["work-dir"],
		);
	throw new Error("Unknown recovery operation");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
