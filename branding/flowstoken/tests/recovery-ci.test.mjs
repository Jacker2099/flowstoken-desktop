import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	assertSourceCheckout,
	nativeTarInvocation,
	restorePlatform,
	SAFE_ARCHIVE_CHECK,
} from "../../../scripts/flowstoken/recover-release.mjs";
import { checkpoint } from "../../../scripts/flowstoken/release-artifacts.mjs";
import {
	assertRecoveryCheckpoint,
	buildRecoveryPlan,
	originalSubmissionFromLog,
	RECOVERY_PLATFORMS,
	recoveryPlanDigest,
	SOURCE_CONFIG_FILES,
	validateManifestLineage,
	verifyRecoveryPlanOnline,
} from "../../../scripts/flowstoken/release-recovery-identity.mjs";

const sourceSha = "a".repeat(40);
const controllerSha = "b".repeat(40);
const uuid = "11111111-2222-3333-4444-555555555555";
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const copy = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
	const sourceRun = {
		id: 123,
		head_sha: sourceSha,
		run_attempt: 1,
		status: "completed",
		event: "workflow_dispatch",
		path: ".github/workflows/desktop-release.yml",
	};
	const jobs = RECOVERY_PLATFORMS.map((platform, index) => ({
		id: 100 + index,
		name: `build ${platform}`,
		status: "completed",
		conclusion: platform.startsWith("macos-") ? "failure" : "success",
	}));
	const artifacts = RECOVERY_PLATFORMS.map((platform, index) => ({
		id: 200 + index,
		name: `${platform.startsWith("macos-") ? "failed-macos" : "release-build"}-${platform}`,
		digest: `sha256:${String(index).repeat(64)}`,
		size_in_bytes: 1000 + index,
		expired: false,
		workflow_run: { id: 123, head_sha: sourceSha },
	}));
	return {
		repo: "Jacker2099/flowstoken-desktop",
		controllerSha,
		recoveryRun: "456",
		sourceSha,
		sourceAttempt: 1,
		version: "0.6.3",
		configHashes: Object.fromEntries(SOURCE_CONFIG_FILES.map((name) => [name, sha256(name)])),
		sourceRun,
		jobs,
		artifacts,
		submissions: { "macos-arm64": uuid, "macos-x64": uuid.replace("11111111", "99999999") },
		submissionIdsByJob: { 102: uuid, 103: uuid.replace("11111111", "99999999") },
	};
}
function lineage(plan) {
	return RECOVERY_PLATFORMS.map((platform) => {
		const origin = plan.platforms[platform];
		const arch = platform.slice("macos-".length);
		const signatureArch = arch === "x64" ? "x86_64" : arch;
		const identity = {
			appName: "FlowsToken.app",
			bundleId: "com.flowstoken.desktop",
			version: "0.6.3",
			teamId: "36G5T56368",
			architectures: [signatureArch],
			signatureHashes: { [signatureArch]: "c".repeat(40) },
		};
		return {
			sha: sourceSha,
			controllerSha,
			run: "456",
			attempt: 1,
			version: "0.6.3",
			platform,
			recovery: {
				planDigest: recoveryPlanDigest(plan),
				origin,
				...(origin.mode === "signed-app"
					? {
							notarization: {
								schema: 1,
								submissionId: origin.submissionId,
								phase: "stapled",
								identity,
								acceptance: { submissionId: origin.submissionId, signatureHashes: identity.signatureHashes },
							},
							packaging: {
								schema: 1,
								sourceSha,
								version: "0.6.3",
								arch,
								appId: identity.bundleId,
								cdhash: identity.signatureHashes[signatureArch],
								teamId: identity.teamId,
							},
						}
					: {}),
			},
		};
	});
}

async function sourceFixture() {
	const directory = await mkdtemp(join(tmpdir(), "recovery-source-flow-"));
	for (const file of SOURCE_CONFIG_FILES) {
		await mkdir(join(directory, file, ".."), { recursive: true });
		await writeFile(
			join(directory, file),
			file === "apps/desktop/package.json" ? '{"version":"0.6.3"}\n' : `fixture ${file}\n`,
		);
	}
	const git = (...args) =>
		execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q");
	git("add", "--", ...SOURCE_CONFIG_FILES);
	git("-c", "user.name=Recovery Test", "-c", "user.email=recovery@example.invalid", "commit", "-qm", "fixture");
	const input = fixture();
	input.sourceSha = git("rev-parse", "HEAD").trim();
	input.sourceRun.head_sha = input.sourceSha;
	for (const artifact of input.artifacts) artifact.workflow_run.head_sha = input.sourceSha;
	for (const file of SOURCE_CONFIG_FILES) input.configHashes[file] = sha256(git("show", `HEAD:${file}`));
	return {
		directory,
		plan: buildRecoveryPlan(input),
		api: async (path) =>
			path.includes("/artifacts/")
				? input.artifacts.find((artifact) => path.endsWith(`/${artifact.id}`))
				: input.sourceRun,
	};
}

test("the original notary UUID must be unique in that exact job's observed submission records", () => {
	const url = `https://appstoreconnect.apple.com/notary/v2/submissions/${uuid}`;
	assert.equal(originalSubmissionFromLog(`${url}\n${url}`, uuid), uuid);
	assert.equal(
		originalSubmissionFromLog(`[notarize-mac] Submission ${uuid} recorded; waiting on the original ID`, uuid),
		uuid,
	);
	assert.throws(() => originalSubmissionFromLog("no submission record", uuid), /uniquely/);
	assert.throws(() => originalSubmissionFromLog(`${url}\n${url.replace("11111111", "99999999")}`, uuid), /uniquely/);
	assert.throws(() => originalSubmissionFromLog(url, uuid.replace("11111111", "99999999")), /uniquely/);
	const input = fixture();
	input.submissionIdsByJob[102] = input.submissions["macos-x64"];
	assert.throws(() => buildRecoveryPlan(input), /source job log/);
});

test("Windows extraction always selects native bsdtar for Windows drive paths", () => {
	const archive = String.raw`D:\a\_temp\restore\failed-macos.tar`;
	const directory = String.raw`D:\a\_temp\restore`;
	const result = nativeTarInvocation(archive, directory, {
		platform: "win32",
		environment: { SystemRoot: String.raw`C:\Windows` },
		exists: (path) => path === String.raw`C:\Windows\System32\tar.exe`,
	});
	assert.equal(result.file, String.raw`C:\Windows\System32\tar.exe`);
	assert.deepEqual(result.args, ["-xf", archive, "-C", directory]);
	assert.throws(
		() =>
			nativeTarInvocation(archive, directory, {
				platform: "win32",
				environment: { SystemRoot: String.raw`C:\Windows` },
				exists: () => false,
			}),
		/Native Windows/,
	);
	assert.equal(nativeTarInvocation("/tmp/app.tar", "/tmp/app", { platform: "darwin" }).file, "/usr/bin/tar");
});

test("the Windows restore path preserves original bytes and writes an honest new-run recovery result", async () => {
	const { directory, plan, api } = await sourceFixture();
	try {
		const original = join(directory, "original");
		await mkdir(original);
		await writeFile(join(original, "fixture.zip"), "original Windows package bytes");
		await writeFile(join(original, "release-publish.txt"), "false\n");
		await checkpoint(original, {
			sha: plan.source.sha,
			run: "123",
			attempt: 1,
			version: "0.6.3",
			platform: "windows",
		});
		await restorePlatform(plan, "windows", directory, "/controller", directory, {
			api,
			environment: { GITHUB_SHA: controllerSha, GITHUB_RUN_ID: "456" },
			download: async (_repo, artifact, target, member) => {
				assert.equal(artifact.id, plan.platforms.windows.artifact.id);
				assert.equal(member, "release-build.tar");
				await cp(original, join(target, "release"), { recursive: true });
			},
			execute: () => {
				throw new Error("A retained Windows build must not sign, package or notarize");
			},
		});
		assert.equal(
			await readFile(join(directory, "apps/desktop/release/fixture.zip"), "utf8"),
			"original Windows package bytes",
		);
		const result = JSON.parse(await readFile(join(directory, "apps/desktop/release/recovery-result.json"), "utf8"));
		assert.equal(result.planDigest, recoveryPlanDigest(plan));
		assert.deepEqual(result.origin, plan.platforms.windows);
		assert.equal(result.notarization, undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Intel recovery resumes only its original request and pending Apple status cannot reach packaging", async () => {
	for (const accepted of [true, false]) {
		const { directory, plan, api } = await sourceFixture();
		const calls = [];
		try {
			const restore = restorePlatform(plan, "macos-x64", directory, "/controller", directory, {
				api,
				environment: { GITHUB_SHA: controllerSha, GITHUB_RUN_ID: "456", CSC_LINK: "must-not-reach-tools" },
				download: async (_repo, _artifact, target) => {
					await mkdir(join(target, "release/mac/FlowsToken.app"), { recursive: true });
				},
				execute: async (_file, args, options) => {
					calls.push(args);
					assert.equal(options.env.CSC_LINK, undefined);
					const value = (name) => args[args.indexOf(name) + 1];
					if (args[0].endsWith("notarize-mac-app.mjs")) {
						assert.ok(args.includes("--resume-only"));
						assert.equal(value("--submission-id"), plan.platforms["macos-x64"].submissionId);
						const receipt = lineage(plan).find((entry) => entry.platform === "macos-x64").recovery.notarization;
						receipt.phase = accepted ? "stapled" : "pending";
						await mkdir(value("--state-dir"));
						await writeFile(join(value("--state-dir"), "receipt.json"), JSON.stringify(receipt));
					} else {
						assert.ok(args[0].endsWith("repackage-notarized-mac.mjs"));
						assert.equal(value("--source-sha"), plan.source.sha);
						assert.equal(value("--arch"), "x64");
						await mkdir(value("--output"), { recursive: true });
						await writeFile(
							join(value("--output"), "recovery-repackage.json"),
							JSON.stringify({
								schema: 1,
								sourceSha: plan.source.sha,
								version: "0.6.3",
								arch: "x64",
								appId: "com.flowstoken.desktop",
								cdhash: "c".repeat(40),
								teamId: "36G5T56368",
								checkpointApp: "mac/FlowsToken.app",
							}),
						);
					}
				},
			});
			if (accepted) {
				await restore;
				assert.equal(calls.length, 2);
				const result = JSON.parse(
					await readFile(join(directory, "apps/desktop/release/recovery-result.json"), "utf8"),
				);
				assert.equal(result.notarization.identity.signatureHashes.x86_64, result.packaging.cdhash);
			} else {
				await assert.rejects(restore, /Notarization receipt/);
				assert.equal(calls.length, 1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("recovery preserves original artifact identities while recording a different controller and actual new run", () => {
	const plan = buildRecoveryPlan(fixture());
	assert.equal(plan.controllerSha, controllerSha);
	assert.equal(plan.source.sha, sourceSha);
	assert.equal(plan.source.run, "123");
	assert.equal(plan.recoveryRun, "456");
	assert.equal(plan.platforms.windows.mode, "checkpoint");
	assert.equal(plan.platforms["macos-arm64"].mode, "signed-app");
	assert.equal(plan.platforms["macos-arm64"].submissionId, uuid);
	assert.match(plan.platforms.windows.artifact.digest, /^sha256:/);
});

test("a pending or different original run/attempt/source can never produce a recovery plan", () => {
	for (const change of [
		{ status: "in_progress" },
		{ run_attempt: 2 },
		{ head_sha: controllerSha },
		{ event: "push" },
		{ path: ".github/workflows/other.yml" },
	]) {
		const input = fixture();
		Object.assign(input.sourceRun, change);
		assert.throws(() => buildRecoveryPlan(input), /Original run/);
	}
});

test("recovery rejects foreign, expired, unbound or missing platform artifacts and absent original submission IDs", () => {
	for (const mutate of [
		(input) => {
			input.artifacts.pop();
		},
		(input) => {
			input.artifacts[0].expired = true;
		},
		(input) => {
			input.artifacts[0].digest = undefined;
		},
		(input) => {
			input.artifacts[0].workflow_run.head_sha = controllerSha;
		},
		(input) => {
			input.artifacts[0].workflow_run.id = 999;
		},
		(input) => {
			input.jobs[0].conclusion = "failure";
		},
		(input) => {
			input.submissions["macos-arm64"] = undefined;
		},
	]) {
		const input = fixture();
		mutate(input);
		assert.throws(() => buildRecoveryPlan(input));
	}
});

test("online checks pin the original run attempt and immutable artifact ID, size and digest", async () => {
	const input = fixture();
	const plan = buildRecoveryPlan(input);
	const api = async (path) =>
		path.includes("/artifacts/")
			? input.artifacts.find((artifact) => path.endsWith(`/${artifact.id}`))
			: input.sourceRun;
	await verifyRecoveryPlanOnline(plan, api);
	input.artifacts[0].digest = `sha256:${"f".repeat(64)}`;
	await assert.rejects(verifyRecoveryPlanOnline(plan, api), /artifact changed/);
	input.sourceRun.run_attempt = 2;
	await assert.rejects(verifyRecoveryPlanOnline(plan, api), /run changed/);
});

test("ordinary reuse still rejects cross-SHA or recovery checkpoints unless an exact recovery plan is supplied", () => {
	const plan = buildRecoveryPlan(fixture());
	const saved = lineage(plan)[0];
	assert.throws(() => assertRecoveryCheckpoint(saved, { ...saved, controllerSha: sourceSha }), /controller/);
	assert.throws(() => assertRecoveryCheckpoint(saved, saved), /controller identity/);
	assert.doesNotThrow(() => assertRecoveryCheckpoint(saved, saved, plan));
	const altered = copy(plan);
	altered.platforms.linux.artifact.digest = `sha256:${"f".repeat(64)}`;
	assert.throws(() => assertRecoveryCheckpoint(saved, saved, altered), /lineage/);
});

test("a public recovery manifest requires four exact source lineages and accepted/stapled matching-CDHash Mac evidence", () => {
	const plan = buildRecoveryPlan(fixture());
	const manifest = {
		sha: sourceSha,
		controllerSha,
		run: "456",
		attempt: 1,
		version: "0.6.3",
		recoveryPlan: plan,
		lineage: lineage(plan),
	};
	assert.doesNotThrow(() => validateManifestLineage(manifest));
	for (const mutate of [
		(value) => {
			value.lineage.pop();
		},
		(value) => {
			value.recoveryPlan = undefined;
		},
		(value) => {
			value.lineage[0].run = "123";
		},
		(value) => {
			value.lineage[2].recovery.notarization.phase = "pending";
		},
		(value) => {
			value.lineage[2].recovery.notarization.acceptance.submissionId = "different";
		},
		(value) => {
			value.lineage[2].recovery.packaging.cdhash = "different";
		},
	]) {
		const value = copy(manifest);
		mutate(value);
		assert.throws(() => validateManifestLineage(value));
	}
});

test("restored checkpoint bytes must still match their original producer before recording the new run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "recovery-checkpoint-"));
	try {
		await writeFile(join(directory, "fixture.zip"), "original bytes");
		const original = { sha: sourceSha, run: "123", attempt: 1, version: "0.6.3", platform: "windows" };
		await checkpoint(directory, original);
		await checkpoint(directory, original, true);
		await writeFile(join(directory, "fixture.zip"), "different bytes");
		await assert.rejects(checkpoint(directory, original, true), /hashes changed/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("normal release planning keeps app and controller SHA identical without accessing GitHub", async () => {
	const directory = await mkdtemp(join(tmpdir(), "normal-release-identity-"));
	try {
		await mkdir(join(directory, "apps/desktop"), { recursive: true });
		await writeFile(join(directory, "apps/desktop/package.json"), JSON.stringify({ version: "0.6.3" }));
		const output = join(directory, "output");
		const env = {
			...process.env,
			GITHUB_REPOSITORY: "Jacker2099/flowstoken-desktop",
			GITHUB_SHA: controllerSha,
			GITHUB_RUN_ID: "456",
			GITHUB_OUTPUT: output,
			RECOVERY_SOURCE_RUN: "",
			RECOVERY_SOURCE_SHA: "",
			RECOVERY_SOURCE_ATTEMPT: "",
			RECOVERY_ARM64_SUBMISSION: "",
			RECOVERY_X64_SUBMISSION: "",
		};
		const result = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dirname, "../../../scripts/flowstoken/recover-release.mjs"),
				"--mode",
				"plan",
				"--out",
				join(directory, "unused.json"),
			],
			{ cwd: directory, env, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(await readFile(output, "utf8"), new RegExp(`source_sha=${controllerSha}`));
		assert.match(await readFile(output, "utf8"), /recovery=false/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("source checkout and packaging configuration must remain at the original commit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "recovery-source-config-"));
	try {
		for (const file of SOURCE_CONFIG_FILES) {
			await mkdir(join(directory, file, ".."), { recursive: true });
			await writeFile(
				join(directory, file),
				file === "apps/desktop/package.json" ? '{"version":"0.6.3"}\n' : `fixture ${file}\n`,
			);
		}
		const git = (...args) =>
			execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git("init", "-q");
		git("add", "--", ...SOURCE_CONFIG_FILES);
		git("-c", "user.name=Recovery Test", "-c", "user.email=recovery@example.invalid", "commit", "-qm", "fixture");
		const plan = buildRecoveryPlan(fixture());
		plan.source.sha = git("rev-parse", "HEAD").trim();
		for (const file of SOURCE_CONFIG_FILES) plan.source.configHashes[file] = sha256(git("show", `HEAD:${file}`));
		assert.doesNotThrow(() => assertSourceCheckout(plan, directory));
		await writeFile(join(directory, "apps/desktop/package.json"), '{"version":"0.6.4"}\n');
		assert.throws(() => assertSourceCheckout(plan, directory));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("archive validation rejects traversal before native extraction and does not itself unpack the signed app", async () => {
	const directory = await mkdtemp(join(tmpdir(), "recovery-safe-archive-"));
	const python = process.env.RECOVERY_PYTHON ?? "python";
	try {
		const make =
			"import io,tarfile,zipfile,sys; p,name=sys.argv[1:]; b=io.BytesIO(); t=tarfile.open(fileobj=b,mode='w'); i=tarfile.TarInfo(name); i.size=1; t.addfile(i,io.BytesIO(b'x')); t.close(); z=zipfile.ZipFile(p,'w'); z.writestr('failed-macos.tar',b.getvalue()); z.close()";
		for (const [name, success] of [
			["release/mac/FlowsToken.app/Contents/Info.plist", true],
			["release/../../outside", false],
		]) {
			const archive = join(directory, "input.zip");
			execFileSync(python, ["-c", make, archive, name]);
			const result = spawnSync(python, ["-c", SAFE_ARCHIVE_CHECK, archive, directory, "failed-macos.tar"], {
				encoding: "utf8",
			});
			assert.equal(result.status === 0, success, result.stderr);
		}
		await assert.rejects(readFile(join(directory, "release/mac/FlowsToken.app/Contents/Info.plist")));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("source quality, native platform checks and all four E2E jobs stay real; recovery never moves the old tag or signs", async () => {
	const root = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(process.env.VETTA_RELEASE_SOURCE_ROOT ?? root, "apps/desktop/package.json"));
	const { parse } = require("yaml");
	const inner = parse(await readFile(join(root, ".github/workflows/desktop-release.yml"), "utf8"));
	const outer = parse(await readFile(join(root, ".github/workflows/flowstoken-release.yml"), "utf8"));
	for (const name of ["quality", "build", "verify"]) {
		const steps = inner.jobs[name].steps;
		assert.ok(
			steps.findIndex((step) => step.name === "Stage recovery controller outside the source checkout") <
				steps.findIndex((step) => step.with?.ref),
		);
		assert.equal(steps.find((step) => step.with?.ref).with.ref, "$" + "{{ needs.prepare.outputs.source-sha }}");
	}
	assert.ok(inner.jobs.quality.steps.some((step) => step.run?.includes("notarize-mac-app.node-test.mjs")));
	assert.match(inner.jobs.build.steps.find((step) => step.id === "package").if, /recovery != 'true'/);
	assert.match(
		inner.jobs.build.steps.find((step) => step.name === "Configure macOS signing and notarization").if,
		/recovery != 'true'/,
	);
	assert.ok(inner.jobs.build.steps.some((step) => step.id === "mac-signature"));
	assert.ok(inner.jobs.build.steps.some((step) => step.id === "platform-verification"));
	assert.ok(inner.jobs.build.steps.some((step) => step.id === "windows-packages"));
	assert.ok(inner.jobs.verify.steps.some((step) => step.run?.includes("bun run test:e2e")));
	assert.match(
		outer.jobs.build.steps.find((step) => step.name === "Tag the release commit").if,
		/recovery_source_run == ''/,
	);
	assert.match(outer.jobs.build.steps.find((step) => step.id === "build").run, /--sha "\$GITHUB_SHA"/);
	assert.equal(outer.jobs.publish.needs, "build");
});

test("reuse input is passed as data and rejected before a malformed value can execute shell code", async () => {
	const root = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(process.env.VETTA_RELEASE_SOURCE_ROOT ?? root, "apps/desktop/package.json"));
	const { parse } = require("yaml");
	const outer = parse(await readFile(join(root, ".github/workflows/flowstoken-release.yml"), "utf8"));
	const step = outer.jobs.build.steps.find((entry) => entry.id === "build");
	assert.equal(step.env.REUSE_BUILD_RUN, "$" + "{{ inputs.reuse_build_run }}");
	assert.doesNotMatch(step.run, /\$\{\{\s*inputs\.reuse_build_run/);
	const directory = await mkdtemp(join(tmpdir(), "recovery-reuse-input-"));
	try {
		const marker = join(directory, "unexpected-shell-execution");
		const script = step.run
			.replaceAll("$" + "{{ steps.v.outputs.tag }}", "v0.6.3")
			.replaceAll("$" + "{{ steps.identity.outputs.recovery }}", "false");
		const result = spawnSync("bash", ["-e", "-c", script], {
			cwd: directory,
			encoding: "utf8",
			env: { ...process.env, REUSE_BUILD_RUN: `$(touch ${marker})` },
		});
		assert.equal(result.status, 1);
		assert.match(result.stdout, /reuse_build_run must be numeric/);
		await assert.rejects(readFile(marker));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
