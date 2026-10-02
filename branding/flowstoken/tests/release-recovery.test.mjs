import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	RELEASE_BUILD_JOBS,
	releaseBuildState,
	waitForReleaseBuilds,
} from "../../../scripts/flowstoken/wait-release-builds.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const { parse } = require("yaml");
const workflow = (name) => parse(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8"));
const outer = workflow("flowstoken-release");
const inner = workflow("desktop-release");
const sha = "a".repeat(40);
const options = { repo: "Jacker2099/flowstoken-desktop", runId: "123", expectedSha: sha };
const completedRun = () => ({
	headSha: sha,
	workflowName: "desktop-release",
	event: "workflow_dispatch",
	attempt: 1,
	status: "in_progress",
	jobs: RELEASE_BUILD_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" })),
});

test("publishing starts only after this commit's required build and verification gates and has a separate time budget", () => {
	assert.equal(outer.jobs.publish.needs, "build");
	assert.equal(outer.jobs.publish.if, undefined);
	assert.equal(outer.jobs.publish["timeout-minutes"], 60);
	assert.ok(
		outer.jobs.build["timeout-minutes"] >
			inner.jobs.prepare["timeout-minutes"] +
				inner.jobs.quality["timeout-minutes"] +
				inner.jobs.build["timeout-minutes"] +
				inner.jobs.verify["timeout-minutes"],
	);
	const build = outer.jobs.build.steps.find((step) => step.id === "build");
	assert.match(build.run, /wait-release-builds\.mjs.*--sha "\$GITHUB_SHA"/);
	assert.match(build.run, /test "\$TAGGED" = .*steps\.identity\.outputs\.source_sha/);
	assert.doesNotMatch(build.run, /gh run watch/);
	assert.equal(outer.jobs.build.outputs.run_id, "$" + "{{ steps.build.outputs.run_id }}");
	const collect = outer.jobs.publish.steps.find(
		(step) => step.name === "Collect build artifacts (from the build checkpoints)",
	);
	assert.match(collect.run, /needs\.build\.outputs\.run_id/);
	assert.match(collect.run, /-n "release-build-\$\{platform\}"/);
	assert.doesNotMatch(collect.run, /failed-macos/);
	assert.match(collect.run, /release-publish\.txt/);
	const identityChecks = outer.jobs.publish.steps.filter((step) => step.run?.includes("wait-release-builds.mjs"));
	assert.equal(identityChecks.length, 2);
	for (const step of identityChecks) assert.match(step.run, /--attempt .*needs\.build\.outputs\.attempt.*--check/);
});

test("a macOS checkpoint is uploaded only after mandatory signature verification", () => {
	const steps = inner.jobs.build.steps;
	const packageIndex = steps.findIndex((step) => step.id === "package");
	const signatureIndex = steps.findIndex((step) => step.id === "mac-signature");
	const archiveIndex = steps.findIndex((step) => step.name === "Archive build checkpoint");
	const uploadIndex = steps.findIndex((step) => step.name === "Upload build checkpoint");
	assert.ok(packageIndex < signatureIndex && signatureIndex < archiveIndex && archiveIndex < uploadIndex);
	assert.equal(steps[packageIndex]["timeout-minutes"], 240);
	assert.ok(inner.jobs.build["timeout-minutes"] > steps[packageIndex]["timeout-minutes"]);
	assert.equal(steps[signatureIndex].if, "matrix.macArch != ''");
	assert.equal(steps[signatureIndex].run, "bun run verify:updates:mac");
	for (const index of [packageIndex, signatureIndex, archiveIndex, uploadIndex]) {
		assert.notEqual(steps[index]["continue-on-error"], true);
	}
	assert.equal(steps[archiveIndex].if, undefined);
	assert.equal(steps[uploadIndex].if, undefined);
});

test("Windows and Linux updater gates inherit packaging configuration and block completed checkpoints", () => {
	const steps = inner.jobs.build.steps;
	const configIndex = steps.findIndex((step) => step.name === "Apply resolved release configuration");
	const packageIndex = steps.findIndex((step) => step.id === "package");
	const gateIndex = steps.findIndex((step) => step.id === "platform-verification");
	const checkpointIndex = steps.findIndex((step) => step.name === "Record checkpoint provenance and file hashes");
	const gate = steps[gateIndex];
	assert.ok(configIndex >= 0 && configIndex < packageIndex && packageIndex < gateIndex && gateIndex < checkpointIndex);
	assert.equal(gate.if, "matrix.macArch == '' && matrix.verify != ''");
	assert.equal(gate.run, "bun run $" + "{{ matrix.verify }}");
	assert.equal(gate["working-directory"], "apps/desktop");
	assert.equal(gate.env, undefined);
	assert.notEqual(gate["continue-on-error"], true);
	assert.match(steps[configIndex].run, /--from-outputs --export-env.*GITHUB_ENV/);
	const platformCommands = inner.jobs.build.strategy.matrix.include
		.filter((platform) => platform.macArch === "")
		.map(({ platform, verify }) => [platform, verify])
		.sort();
	assert.deepEqual(platformCommands, [
		["linux", "verify:updates:linux:release"],
		["windows", "verify:updates:windows"],
	]);
	for (const name of [
		"Record checkpoint provenance and file hashes",
		"Archive build checkpoint",
		"Upload build checkpoint",
	]) {
		assert.equal(steps.find((step) => step.name === name).if, undefined);
	}
});

test("Windows supplemental ZIP validation is required before the build can upload its checkpoint", () => {
	const steps = inner.jobs.build.steps;
	const updaterIndex = steps.findIndex((step) => step.id === "platform-verification");
	const supplementalIndex = steps.findIndex((step) => step.id === "windows-packages");
	const checkpointIndex = steps.findIndex((step) => step.name === "Record checkpoint provenance and file hashes");
	const gate = steps[supplementalIndex];
	assert.ok(updaterIndex < supplementalIndex && supplementalIndex < checkpointIndex);
	assert.equal(gate.if, "matrix.platform == 'windows'");
	assert.equal(gate.run, "bun run verify:packages:windows");
	assert.equal(gate["working-directory"], "apps/desktop");
	assert.equal(gate.env, undefined);
	assert.notEqual(gate["continue-on-error"], true);
});

test("failed macOS files are archived separately, preserving the bundle but excluding builder diagnostics", () => {
	const steps = inner.jobs.build.steps;
	const archive = steps.find((step) => step.id === "failed-macos");
	const upload = steps.find((step) => step.name === "Upload failed macOS build diagnostics");
	assert.match(
		archive.if,
		/always\(\).*steps\.package\.outcome == 'failure'.*steps\.mac-signature\.outcome == 'failure'/,
	);
	assert.equal(upload.with.name, "failed-macos-$" + "{{ matrix.platform }}");
	assert.match(upload.if, /steps\.failed-macos\.outputs\.saved == 'true'/);
	const temporary = mkdtempSync(join(tmpdir(), "flowstoken-partial-"));
	try {
		const release = join(temporary, "apps/desktop/release");
		mkdirSync(join(release, "FlowsToken.app/Contents"), { recursive: true });
		mkdirSync(join(temporary, "runner"));
		writeFileSync(join(release, "FlowsToken.app/Contents/app"), "signed binary fixture");
		chmodSync(join(release, "FlowsToken.app/Contents/app"), 0o755);
		symlinkSync("app", join(release, "FlowsToken.app/Contents/link"));
		writeFileSync(join(release, "builder-debug.yml"), "excluded fixture");
		writeFileSync(join(release, "builder-effective-config.yaml"), "excluded fixture");
		execFileSync("bash", ["-e", "-o", "pipefail", "-c", archive.run], {
			cwd: temporary,
			env: {
				...process.env,
				RUNNER_TEMP: join(temporary, "runner"),
				GITHUB_WORKSPACE: temporary,
				GITHUB_OUTPUT: join(temporary, "output"),
			},
		});
		const entries = execFileSync("tar", ["-tvf", join(temporary, "runner/failed-macos.tar")], { encoding: "utf8" });
		assert.match(entries, /FlowsToken\.app\/Contents\/app/);
		assert.match(entries, /FlowsToken\.app\/Contents\/link -> app/);
		assert.doesNotMatch(entries, /builder-debug|builder-effective-config|require-mac-signature/);
		assert.equal(readFileSync(join(temporary, "output"), "utf8"), "saved=true\n");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("all four verification jobs are mandatory even after quality and every build pass", () => {
	const expected = [inner.jobs.quality.name];
	const quality = workflow("quality");
	expected.push(`${inner.jobs["source-quality"].name} / ${quality.jobs["check-and-test"].name}`);
	for (const os of quality.jobs["unit-tests"].strategy.matrix.os)
		expected.push(`${inner.jobs["source-quality"].name} / affected unit tests (${os})`);
	for (const job of ["build", "verify"]) {
		for (const { platform } of inner.jobs[job].strategy.matrix.include) expected.push(`${job} ${platform}`);
	}
	assert.deepEqual([...RELEASE_BUILD_JOBS].sort(), expected.sort());
	for (const { platform } of inner.jobs.verify.strategy.matrix.include) {
		const name = `verify ${platform}`;
		const run = completedRun();
		const verification = run.jobs.find((job) => job.name === name);
		for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
			verification.conclusion = conclusion;
			assert.equal(releaseBuildState(run, sha).state, "failure", `${name}: ${conclusion}`);
		}
		verification.status = "in_progress";
		verification.conclusion = null;
		assert.equal(releaseBuildState(run, sha).state, "pending", name);
		run.jobs = run.jobs.filter((job) => job.name !== name);
		assert.equal(releaseBuildState(run, sha).state, "pending", name);
		run.status = "completed";
		assert.equal(releaseBuildState(run, sha).state, "failure", name);
	}
	assert.deepEqual(releaseBuildState(completedRun(), sha), { state: "success", attempt: 1 });
});

test("the packaged E2E step propagates a failed WDIO run on every platform", () => {
	const step = inner.jobs.verify.steps.find((entry) => entry.name === "Run packaged app and updater E2E");
	assert.notEqual(step["continue-on-error"], true);
	assert.equal(step.env.VETTA_E2E_PACKAGED, "1");
	assert.equal(step.env.VETTA_E2E_UPDATE_FEED, "1");
	const temporary = mkdtempSync(join(tmpdir(), "flowstoken-strict-e2e-"));
	try {
		const bun = join(temporary, "bun");
		const xvfb = join(temporary, "xvfb-run");
		writeFileSync(
			bun,
			'#!/bin/sh\n[ "$2" != "test:e2e:packaged" ] || exit 0\n[ "$2" = "test:e2e" ] || exit 99\n[ "$VETTA_E2E_PACKAGED" = "1" ] && [ "$VETTA_E2E_UPDATE_FEED" = "1" ] || exit 98\nexit 23\n',
		);
		writeFileSync(xvfb, '#!/bin/sh\nshift\nexec "$@"\n');
		chmodSync(bun, 0o755);
		chmodSync(xvfb, 0o755);
		for (const { platform } of inner.jobs.verify.strategy.matrix.include) {
			const result = spawnSync(
				"bash",
				["-e", "-o", "pipefail", "-c", step.run.replaceAll("$" + "{{ matrix.platform }}", platform)],
				{
					cwd: temporary,
					encoding: "utf8",
					env: { ...process.env, ...step.env, PATH: `${temporary}:${process.env.PATH}` },
				},
			);
			assert.equal(result.status, 23, `${platform}: ${result.stderr}`);
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("the release wait follows a pending verification through success", async () => {
	let reads = 0;
	let time = 0;
	await waitForReleaseBuilds({
		...options,
		read: () => {
			const run = completedRun();
			if (reads++ === 0) run.jobs.find((job) => job.name === "verify macos-arm64").status = "in_progress";
			return run;
		},
		now: () => time,
		delay: async (milliseconds) => {
			time += milliseconds;
		},
	});
	assert.equal(reads, 2);
	assert.equal(time, 60_000);
});

test("failed or absent required jobs block publication", () => {
	for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
		const run = completedRun();
		run.jobs[3].conclusion = conclusion;
		assert.equal(releaseBuildState(run, sha).state, "failure");
	}
	const run = completedRun();
	run.jobs.pop();
	assert.equal(releaseBuildState(run, sha).state, "pending");
	run.status = "completed";
	assert.equal(releaseBuildState(run, sha).state, "failure");
});

test("a completed build from the previous commit or another workflow cannot be reused", async () => {
	for (const replacement of [{ headSha: "b".repeat(40) }, { workflowName: "other-workflow" }, { event: "push" }]) {
		await assert.rejects(
			waitForReleaseBuilds({ ...options, read: () => ({ ...completedRun(), ...replacement }) }),
			/refused/,
		);
	}
});

test("a rerun while waiting cannot replace the observed build attempt", async () => {
	let reads = 0;
	await assert.rejects(
		waitForReleaseBuilds({
			...options,
			read: () => ({ ...completedRun(), jobs: [], attempt: ++reads }),
			delay: async () => {},
		}),
		/restarted/,
	);
	assert.equal(releaseBuildState(completedRun(), sha, 2).state, "failure");
});

test("the wait exits at its deadline when Apple is still processing", async () => {
	let time = 0;
	await assert.rejects(
		waitForReleaseBuilds({
			...options,
			read: () => ({ ...completedRun(), jobs: [] }),
			now: () => time,
			delay: async (milliseconds) => {
				time += milliseconds;
			},
			timeoutMs: 90_000,
		}),
		/Timed out/,
	);
	assert.equal(time, 90_000);
});

test("the default verification wait is bounded at 340 minutes within the 360-minute parent", async () => {
	let time = 0;
	await assert.rejects(
		waitForReleaseBuilds({
			...options,
			read: () => ({ ...completedRun(), jobs: [] }),
			now: () => time,
			delay: async (milliseconds) => {
				time += milliseconds;
			},
		}),
		/Timed out/,
	);
	assert.equal(time, 340 * 60_000);
	assert.equal(outer.jobs.build["timeout-minutes"], 360);
});

test("the workflow CLI queries GitHub and returns failure for a stale run", () => {
	const temporary = mkdtempSync(join(tmpdir(), "flowstoken-build-cli-"));
	try {
		const gh = join(temporary, "gh");
		writeFileSync(gh, "#!/usr/bin/env node\nprocess.stdout.write(process.env.TEST_GH_RUN);\n");
		chmodSync(gh, 0o755);
		const script = join(root, "scripts/flowstoken/wait-release-builds.mjs");
		for (const [headSha, expectedStatus] of [
			[sha, 0],
			["b".repeat(40), 1],
		]) {
			const result = spawnSync(
				process.execPath,
				[script, "--repo", options.repo, "--run", options.runId, "--sha", sha],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${temporary}:${process.env.PATH}`,
						GITHUB_OUTPUT: join(temporary, "cli-output"),
						TEST_GH_RUN: JSON.stringify({ ...completedRun(), headSha }),
					},
				},
			);
			assert.equal(result.status, expectedStatus, result.stderr);
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
