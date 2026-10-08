import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { prepareVerificationHarness } from "../../../scripts/flowstoken/prepare-verification-harness.mjs";
import { stageController } from "../../../scripts/flowstoken/recover-release.mjs";
import { checkpoint } from "../../../scripts/flowstoken/release-artifacts.mjs";
import {
	buildRecoveryPlan,
	RECOVERY_PLATFORMS,
	recoveryPlanDigest,
	SOURCE_CONFIG_FILES,
} from "../../../scripts/flowstoken/release-recovery-identity.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(join(process.env.VETTA_RELEASE_SOURCE_ROOT ?? root, "apps/desktop/package.json"));
function verificationJob() {
	const { parse } = require("yaml");
	return parse(readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8")).jobs.verify;
}
const hash = (body) => createHash("sha256").update(body).digest("hex");
const fixtureWdio = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.argv[2] !== 'run' || process.argv[3] !== './wdio.conf.ts') process.exit(96);
if (readFileSync('wdio.conf.ts','utf8') !== '// CONTROLLER CONFIG\\n') process.exit(97);
if (readFileSync('e2e/updater.e2e.ts','utf8') !== '// CONTROLLER SPEC\\n') process.exit(98);
if (process.env.HARNESS_DEPENDENCY_PROBE === '1') {
  const { probe } = await import(pathToFileURL(resolve('e2e/dependency-probe.mjs')).href);
  if (probe !== 'original scoped + original unscoped') process.exit(99);
}
const pkg=JSON.parse(readFileSync('package.json','utf8'));
writeFileSync(process.env.HARNESS_AUDIT,JSON.stringify({cwd:process.cwd(),version:pkg.version,artifactRoot:process.env.VETTA_E2E_PACKAGED_ROOT,packaged:process.env.VETTA_E2E_PACKAGED,updateFeed:process.env.VETTA_E2E_UPDATE_FEED}));
process.exit(23);
`;
function put(rootDir, file, body) {
	mkdirSync(dirname(join(rootDir, file)), { recursive: true });
	writeFileSync(join(rootDir, file), body);
}
function git(rootDir, ...args) {
	return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function commit(rootDir) {
	git(rootDir, "init", "-q");
	git(rootDir, "add", "--", ".");
	git(
		rootDir,
		"-c",
		"user.name=Verification Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"fixture",
	);
	return git(rootDir, "rev-parse", "HEAD").trim();
}

function installIsolatedFixture(source, temporary, pkg) {
	const packages = join(temporary, "local-packages");
	for (const [name, directory, body] of [
		["@wdio/cli", "cli", "export const identity = 'original scoped';\n"],
		["harness-dependency", "dependency", "export const identity = 'original unscoped';\n"],
	]) {
		const packageRoot = join(packages, directory);
		put(packageRoot, "index.js", body);
		put(
			packageRoot,
			"package.json",
			JSON.stringify({
				name,
				version: "9.30.0",
				type: "module",
				exports: "./index.js",
				...(name === "@wdio/cli" ? { bin: { wdio: "./bin/wdio.js" } } : {}),
			}),
		);
		if (name === "@wdio/cli") {
			put(packageRoot, "bin/wdio.js", fixtureWdio);
			chmodSync(join(packageRoot, "bin/wdio.js"), 0o755);
		}
		execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", join(packages, `${directory}.tgz`)], {
			cwd: packageRoot,
			stdio: "pipe",
		});
	}
	put(source, "package.json", JSON.stringify({ name: "harness-fixture", private: true, workspaces: ["apps/desktop"] }));
	put(
		source,
		"apps/desktop/package.json",
		JSON.stringify({
			...pkg,
			name: "harness-desktop-fixture",
			devDependencies: {
				"@wdio/cli": "file:../../../local-packages/cli.tgz",
				"harness-dependency": "file:../../../local-packages/dependency.tgz",
			},
		}),
	);
	rmSync(join(source, "bun.lock"));
	execFileSync(
		"bun",
		["install", "--linker", "isolated", "--ignore-scripts", "--cache-dir", join(temporary, "bun-cache")],
		{
			cwd: source,
			stdio: "pipe",
			env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL: "1" },
		},
	);
}

async function makeFixture(platform = "linux", { isolated = false } = {}) {
	const temporary = mkdtempSync(join(tmpdir(), "flowstoken-verification-harness-"));
	const source = join(temporary, "source");
	const controller = join(temporary, "controller");
	const snapshot = join(temporary, "controller-snapshot");
	const destination = join(temporary, "harness");
	mkdirSync(source);
	mkdirSync(controller);
	const pkg = { version: "0.6.3", type: "module", scripts: { "test:e2e": "wdio run ./wdio.conf.ts" } };
	put(source, "apps/desktop/package.json", `${JSON.stringify(pkg, null, 2)}\n`);
	put(source, "apps/desktop/scripts/prepare-pack.js", "// original packaging source\n");
	put(source, "bun.lock", "original dependency lock\n");
	put(source, "apps/desktop/wdio.conf.ts", "// OLD SOURCE CONFIG\n");
	put(source, "apps/desktop/e2e/updater.e2e.ts", "// OLD SOURCE SPEC\n");
	put(source, ".gitignore", "node_modules/\napps/desktop/release/\n");
	if (isolated) installIsolatedFixture(source, temporary, pkg);
	const sourceSha = commit(source);
	put(controller, "apps/desktop/package.json", JSON.stringify({ ...pkg, version: "9.9.9" }));
	put(controller, "apps/desktop/wdio.conf.ts", "// CONTROLLER CONFIG\n");
	put(controller, "apps/desktop/e2e/updater.e2e.ts", "// CONTROLLER SPEC\n");
	put(controller, "apps/desktop/e2e/updater-auth-fixture.ts", "// CONTROLLER AUTH FIXTURE\n");
	if (isolated)
		put(
			controller,
			"apps/desktop/e2e/dependency-probe.mjs",
			"import { identity as scoped } from '@wdio/cli';\nimport { identity as unscoped } from 'harness-dependency';\nexport const probe = scoped + ' + ' + unscoped;\n",
		);
	for (const name of ["electron-e2e-service-options.mjs", "packaged-e2e-binary.mjs"])
		put(controller, `apps/desktop/scripts/${name}`, "export {};\n");
	for (const folder of ["scripts/flowstoken", "scripts/release", "branding/flowstoken", ".github/workflows"])
		put(controller, `${folder}/fixture.txt`, "fixture\n");
	const controllerSha = commit(controller);
	const controllerManifest = stageController(snapshot, {
		sourceRoot: controller,
		controllerSha,
		envFile: join(temporary, "github-env"),
	});
	const plan = buildRecoveryPlan({
		repo: "Jacker2099/flowstoken-desktop",
		controllerSha,
		recoveryRun: "456",
		sourceSha,
		sourceAttempt: 1,
		version: pkg.version,
		configHashes: Object.fromEntries(
			SOURCE_CONFIG_FILES.map((name) => [name, hash(git(source, "show", `HEAD:${name}`))]),
		),
		sourceRun: {
			id: 123,
			head_sha: sourceSha,
			run_attempt: 1,
			status: "completed",
			event: "workflow_dispatch",
			path: ".github/workflows/desktop-release.yml",
		},
		jobs: RECOVERY_PLATFORMS.map((name, index) => ({
			id: index + 1,
			name: `build ${name}`,
			status: "completed",
			conclusion: "success",
		})),
		artifacts: RECOVERY_PLATFORMS.map((name, index) => ({
			id: index + 100,
			name: `release-build-${name}`,
			size_in_bytes: 1000,
			digest: `sha256:${String(index).repeat(64)}`,
			expired: false,
			workflow_run: { id: 123, head_sha: sourceSha },
		})),
	});
	const release = join(source, "apps/desktop/release");
	put(release, "fixture.zip", "ORIGINAL APPLICATION BYTES\n");
	await checkpoint(
		release,
		{
			sha: sourceSha,
			controllerSha,
			run: "456",
			attempt: 1,
			version: pkg.version,
			platform,
			recovery: { planDigest: recoveryPlanDigest(plan), origin: plan.platforms[platform] },
		},
		false,
		plan,
	);
	if (!isolated) {
		const modules = join(source, "apps/desktop/node_modules");
		put(
			modules,
			"@wdio/cli/package.json",
			JSON.stringify({ name: "@wdio/cli", version: "9.30.0", bin: { wdio: "./bin/wdio.js" } }),
		);
		put(modules, "@wdio/cli/bin/wdio.js", fixtureWdio);
		put(modules, ".bin/package.json", '{"type":"module"}\n');
		put(modules, ".bin/wdio", fixtureWdio);
		chmodSync(join(modules, ".bin/wdio"), 0o755);
	}
	const options = {
		controllerRoot: snapshot,
		sourceRoot: source,
		destination,
		plan,
		controllerSha,
		sourceSha,
		runId: "456",
		attempt: 1,
		platform,
	};
	return { temporary, source, controller, snapshot, destination, plan, controllerManifest, options, release };
}

test("verification uses controller tools but the original source version and locked dependencies", async () => {
	const fixture = await makeFixture();
	try {
		const sourcePackage = readFileSync(join(fixture.source, "apps/desktop/package.json"));
		const originalApplication = readFileSync(join(fixture.release, "fixture.zip"));
		const result = await prepareVerificationHarness(fixture.options);
		assert.equal(
			JSON.parse(readFileSync(join(fixture.snapshot, "apps/desktop/package.json"), "utf8")).version,
			"9.9.9",
		);
		assert.equal(JSON.parse(readFileSync(join(result.harnessRoot, "package.json"), "utf8")).version, "0.6.3");
		assert.equal(readFileSync(join(result.harnessRoot, "wdio.conf.ts"), "utf8"), "// CONTROLLER CONFIG\n");
		assert.equal(readFileSync(join(result.harnessRoot, "e2e/updater.e2e.ts"), "utf8"), "// CONTROLLER SPEC\n");
		assert.equal(
			realpathSync(join(result.harnessRoot, "node_modules/@wdio/cli/bin/wdio.js")),
			realpathSync(join(fixture.source, "apps/desktop/node_modules/@wdio/cli/bin/wdio.js")),
		);
		assert.equal(result.packagedRoot, realpathSync(join(fixture.source, "apps/desktop")));
		assert.equal(result.manifest.sourceSha, fixture.plan.source.sha);
		assert.equal(result.manifest.verificationToolingSha, fixture.plan.controllerSha);
		assert.equal(result.manifest.phase, "prepared");
		assert.equal(result.manifest.passed, undefined);
		assert.deepEqual(readFileSync(join(fixture.source, "apps/desktop/package.json")), sourcePackage);
		assert.deepEqual(readFileSync(join(fixture.release, "fixture.zip")), originalApplication);
		assert.equal(git(fixture.source, "status", "--porcelain"), "");
	} finally {
		rmSync(fixture.temporary, { recursive: true, force: true });
	}
});

test("a changed controller, changed tooling, changed original package or in-source destination is refused", async () => {
	for (const mutate of [
		(fixture) => {
			fixture.options.controllerSha = "f".repeat(40);
		},
		(fixture) => put(fixture.snapshot, "apps/desktop/e2e/updater.e2e.ts", "changed after staging\n"),
		(fixture) => put(fixture.source, "apps/desktop/package.json", '{"version":"9.9.9"}\n'),
		(fixture) => {
			fixture.options.destination = join(fixture.source, "new-harness");
		},
	]) {
		const fixture = await makeFixture();
		try {
			mutate(fixture);
			await assert.rejects(prepareVerificationHarness(fixture.options));
		} finally {
			rmSync(fixture.temporary, { recursive: true, force: true });
		}
	}
});

test("the real copied package script runs controller specs and propagates failed WDIO on all three OS branches", async () => {
	const verify = verificationJob();
	const step = verify.steps.find((entry) => entry.name === "Run packaged app and updater E2E");
	assert.match(step["working-directory"], /VETTA_E2E_HARNESS_ROOT/);
	for (const platform of ["windows", "macos-arm64", "linux"]) {
		const fixture = await makeFixture(platform);
		try {
			const result = await prepareVerificationHarness({
				...fixture.options,
				hostPlatform: platform === "windows" ? "win32" : process.platform,
			});
			const bin = join(fixture.temporary, "bin");
			mkdirSync(bin);
			put(bin, "xvfb-run", '#!/bin/sh\nshift\nexec "$@"\n');
			chmodSync(join(bin, "xvfb-run"), 0o755);
			const audit = join(fixture.temporary, "actual-entry.json");
			const command = step.run.replaceAll("$" + "{{ matrix.platform }}", platform);
			const child = spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], {
				cwd: result.harnessRoot,
				encoding: "utf8",
				env: {
					...process.env,
					...verify.env,
					...step.env,
					VETTA_E2E_PACKAGED_ROOT: result.packagedRoot,
					HARNESS_AUDIT: audit,
					PATH: `${bin}:${process.env.PATH}`,
				},
			});
			assert.equal(child.status, 23, `${platform}: ${child.stderr}`);
			assert.deepEqual(JSON.parse(readFileSync(audit, "utf8")), {
				cwd: result.harnessRoot,
				version: "0.6.3",
				artifactRoot: result.packagedRoot,
				packaged: "1",
				updateFeed: "1",
			});
			assert.equal(
				readFileSync(join(fixture.source, "apps/desktop/e2e/updater.e2e.ts"), "utf8"),
				"// OLD SOURCE SPEC\n",
			);
			assert.equal(readFileSync(join(fixture.release, "fixture.zip"), "utf8"), "ORIGINAL APPLICATION BYTES\n");
			assert.equal(git(fixture.source, "status", "--porcelain"), "");
		} finally {
			rmSync(fixture.temporary, { recursive: true, force: true });
		}
	}
});

test("Bun isolated dependencies launch the original strict WDIO script from the relocated verification harness", async () => {
	const fixture = await makeFixture(process.platform === "win32" ? "windows" : "linux", { isolated: true });
	try {
		assert.match(
			realpathSync(join(fixture.source, "apps/desktop/node_modules/@wdio/cli")),
			/node_modules[/\\]\.bun[/\\]/,
		);
		const sourcePackage = readFileSync(join(fixture.source, "apps/desktop/package.json"));
		const sourceLock = readFileSync(join(fixture.source, "bun.lock"));
		const originalApplication = readFileSync(join(fixture.release, "fixture.zip"));
		const result = await prepareVerificationHarness({ ...fixture.options, hostPlatform: "win32" });
		const audit = join(fixture.temporary, "isolated-entry.json");
		const child = spawnSync("bun", ["run", "test:e2e"], {
			cwd: result.harnessRoot,
			encoding: "utf8",
			env: {
				...process.env,
				VETTA_E2E_PACKAGED_ROOT: result.packagedRoot,
				VETTA_E2E_PACKAGED: "1",
				VETTA_E2E_UPDATE_FEED: "1",
				HARNESS_DEPENDENCY_PROBE: "1",
				HARNESS_AUDIT: audit,
			},
		});
		assert.equal(child.status, 23, `Strict WDIO fixture did not propagate its failure: ${child.stderr}`);
		assert.deepEqual(JSON.parse(readFileSync(audit, "utf8")), {
			cwd: result.harnessRoot,
			version: "0.6.3",
			artifactRoot: result.packagedRoot,
			packaged: "1",
			updateFeed: "1",
		});
		assert.equal(
			realpathSync(join(result.harnessRoot, "node_modules/@wdio/cli/bin/wdio.js")),
			realpathSync(join(fixture.source, "apps/desktop/node_modules/@wdio/cli/bin/wdio.js")),
		);
		assert.deepEqual(readFileSync(join(fixture.source, "apps/desktop/package.json")), sourcePackage);
		assert.deepEqual(readFileSync(join(fixture.source, "bun.lock")), sourceLock);
		assert.deepEqual(readFileSync(join(fixture.release, "fixture.zip")), originalApplication);
		assert.equal(git(fixture.source, "status", "--porcelain"), "");
	} finally {
		rmSync(fixture.temporary, { recursive: true, force: true });
	}
});

test("restoring a recovery checkpoint checks the original package version without rewriting source metadata", () => {
	const verify = verificationJob();
	const temporary = mkdtempSync(join(tmpdir(), "verification-source-restore-"));
	try {
		const workspace = join(temporary, "source");
		const runner = join(temporary, "runner");
		const input = join(temporary, "archive");
		mkdirSync(join(runner, "release-checkpoint"), { recursive: true });
		put(input, "release/require-mac-signature.txt", "1\n");
		const packageBytes = '{\n  "version": "0.6.3"\n}\n';
		put(workspace, "apps/desktop/package.json", packageBytes);
		execFileSync("tar", ["-cf", join(runner, "release-checkpoint/release-build.tar"), "-C", input, "release"]);
		const restore = verify.steps.find((entry) => entry.name === "Restore build checkpoint");
		assert.match(restore.env.RECOVERY_MODE, /needs.prepare.outputs.recovery/);
		const options = {
			cwd: workspace,
			encoding: "utf8",
			env: {
				...process.env,
				RUNNER_TEMP: runner,
				GITHUB_ENV: join(temporary, "env"),
				BUILD_VERSION: "0.6.3",
				RECOVERY_MODE: "true",
			},
		};
		execFileSync("bash", ["-e", "-c", restore.run], options);
		assert.equal(readFileSync(join(workspace, "apps/desktop/package.json"), "utf8"), packageBytes);
		assert.notEqual(
			spawnSync("bash", ["-e", "-c", restore.run], { ...options, env: { ...options.env, BUILD_VERSION: "0.6.4" } })
				.status,
			0,
		);
		assert.equal(readFileSync(join(workspace, "apps/desktop/package.json"), "utf8"), packageBytes);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("tooling preparation and its independent diagnostic manifest do not replace the strict verification result", () => {
	const verify = verificationJob();
	const steps = verify.steps;
	const prepare = steps.findIndex((step) => step.id === "verification-harness");
	const e2e = steps.findIndex((step) => step.name === "Run packaged app and updater E2E");
	const upload = steps.find((step) => step.name === "Upload verification tooling manifest");
	assert.ok(prepare > steps.findIndex((step) => step.name === "Restore build checkpoint") && prepare < e2e);
	assert.equal(steps[prepare].if, "needs.prepare.outputs.recovery == 'true'");
	assert.equal(steps[e2e]["continue-on-error"], undefined);
	assert.match(upload.if, /always\(\).*verification-harness.outputs.ready/);
	assert.match(upload.with.name, /^verification-tooling-/);
	assert.doesNotMatch(upload.with.name, /release-build/);
});
