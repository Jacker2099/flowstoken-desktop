import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { publishRelease } from "../../../scripts/flowstoken/publish-release.mjs";
import { restorePlatform } from "../../../scripts/flowstoken/recover-release.mjs";
import { checkpoint, verifyReleaseArtifacts } from "../../../scripts/flowstoken/release-artifacts.mjs";
import { validateRecoveryPlan } from "../../../scripts/flowstoken/release-recovery-identity.mjs";
import { assertReleaseSourceEligible } from "../../../scripts/flowstoken/release-source-policy.mjs";
import { releaseSourceTestPackages, testReleaseSource } from "../../../scripts/flowstoken/test-release-source.mjs";
import { selectSshPlatformSuites, WINDOWS_DESKTOP_SSH_SUITES } from "../../../scripts/flowstoken/test-ssh-platform.mjs";
import { releaseBuildState } from "../../../scripts/flowstoken/wait-release-builds.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const { parse } = require("yaml");
const workflow = (name) => parse(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8"));
const rejected = "c144a9b47d1d5d49a802a9a3a3a2cdbbcdf09323";
const sourceSha = "a".repeat(40);
const controllerSha = "b".repeat(40);

function plan(sha = sourceSha) {
	return {
		schema: 1,
		repo: "Jacker2099/flowstoken-desktop",
		controllerSha,
		recoveryRun: "456",
		source: {
			sha,
			run: "123",
			attempt: 1,
			version: "0.6.4",
			configHashes: Object.fromEntries(
				["apps/desktop/package.json", "apps/desktop/scripts/prepare-pack.js", "bun.lock"].map((name) => [
					name,
					"f".repeat(64),
				]),
			),
		},
		platforms: Object.fromEntries(
			["linux", "windows", "macos-arm64", "macos-x64"].map((platform, index) => [
				platform,
				{
					mode: "checkpoint",
					jobId: 100 + index,
					artifact: {
						id: 200 + index,
						name: `release-build-${platform}`,
						digest: `sha256:${"f".repeat(64)}`,
						size: 1000,
					},
				},
			]),
		),
	};
}

test("the rejected production source cannot recover, collect or publish even with an accepted old notarization", async () => {
	const original = plan(rejected);
	assert.throws(() => validateRecoveryPlan(original), /prohibited from release.*SSH stop/);
	let effects = 0;
	await assert.rejects(
		restorePlatform(original, "macos-arm64", "/unused", "/unused", "/unused", {
			api: () => {
				effects++;
			},
			download: () => {
				effects++;
			},
			execute: () => {
				effects++;
			},
			environment: { GITHUB_SHA: controllerSha, GITHUB_RUN_ID: "456" },
		}),
		/prohibited from release/,
	);
	const identity = { sha: rejected, controllerSha, version: "0.6.4", run: "456", attempt: 1 };
	await assert.rejects(checkpoint("/unused", identity), /prohibited from release/);
	await assert.rejects(verifyReleaseArtifacts("/unused", identity), /prohibited from release/);
	await assert.rejects(
		publishRelease({
			...identity,
			directory: "/unused",
			api: () => {
				effects++;
			},
			run: () => {
				effects++;
			},
		}),
		/prohibited from release/,
	);
	assert.equal(effects, 0);
	assert.doesNotThrow(() => validateRecoveryPlan(plan()));
	assert.doesNotThrow(() => assertReleaseSourceEligible(sourceSha));
});

test("all nine old release gates cannot hide a failed or missing Windows source-quality result", () => {
	const names = [
		"validate and test Desktop release",
		...["build", "verify"].flatMap((kind) =>
			["linux", "windows", "macos-arm64", "macos-x64"].map((platform) => `${kind} ${platform}`),
		),
	];
	const run = {
		headSha: controllerSha,
		workflowName: "desktop-release",
		event: "workflow_dispatch",
		attempt: 1,
		status: "completed",
		jobs: names.map((name) => ({ name, status: "completed", conclusion: "success" })),
	};
	assert.equal(releaseBuildState(run, controllerSha).state, "failure");
	for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
		run.jobs = [
			...names,
			"source quality / check + quality tests",
			"source quality / affected unit tests (ubuntu-latest)",
			"source quality / affected unit tests (macos-latest)",
			"source quality / affected unit tests (windows-latest)",
		].map((name) => ({
			name,
			status: "completed",
			conclusion: name.endsWith("(windows-latest)") ? conclusion : "success",
		}));
		assert.equal(releaseBuildState(run, controllerSha).state, "failure", conclusion);
	}
});

test("normal and recovery packaging depend on exact-source cross-platform quality, with strict packaged E2E retained", () => {
	const release = workflow("desktop-release");
	const quality = workflow("quality");
	assert.equal(release.jobs["source-quality"].uses, "./.github/workflows/quality.yml");
	assert.equal(release.jobs["source-quality"].with.source_sha, "$" + "{{ needs.prepare.outputs.source-sha }}");
	for (const name of ["build", "publish-r2", "publish-github"])
		assert.ok(release.jobs[name].needs.includes("source-quality"));
	assert.equal(quality.on.workflow_call.inputs.source_sha.required, true);
	assert.deepEqual(quality.jobs["unit-tests"].strategy.matrix.os, ["ubuntu-latest", "macos-latest", "windows-latest"]);
	const steps = quality.jobs["unit-tests"].steps;
	const complete = steps.find((step) => step.name === "Test complete release client workspaces and SSH transport");
	assert.equal(complete.if, "inputs.source_sha");
	assert.match(complete.run, /test-release-source\.mjs.*RELEASE_SOURCE_SHA/);
	assert.doesNotMatch(complete.run, /test:changed|origin\/main/);
	assert.notEqual(complete["continue-on-error"], true);
	assert.equal(steps.find((step) => step.name === "Test affected workspaces").if, "$" + "{{ !inputs.source_sha }}");
	const preserve = steps.findIndex(
		(step) => step.name === "Preserve release quality controller before checking out application source",
	);
	assert.ok(preserve < steps.findIndex((step) => step.with?.ref === "$" + "{{ inputs.source_sha }}"));
	const e2e = release.jobs.verify.steps.find((step) => step.name === "Run packaged app and updater E2E");
	assert.notEqual(e2e["continue-on-error"], true);
	assert.match(e2e.run, /bun run test:e2e/);
	assert.doesNotMatch(e2e.run, /\|\||test:e2e:packaged/);
});

test("an empty fork diff still executes complete client suites, and touched workspaces join the release matrix", () => {
	assert.deepEqual(releaseSourceTestPackages([]), ["ai", "coding-agent", "desktop", "runtime-node", "runtime-storage"]);
	const expanded = releaseSourceTestPackages([
		"packages/runtime-core/src/kernel.ts",
		"packages/ssh-transport/src/remote-command.ts",
	]);
	assert.ok(expanded.includes("runtime-core"));
	const calls = [];
	const execute = (_file, args) => (args[0] === "rev-parse" ? sourceSha : "");
	assert.equal(
		testReleaseSource("upstream/v0.5.59", sourceSha, {
			platform: "win32",
			execute,
			run: (args) => {
				calls.push(args);
				return 0;
			},
		}),
		0,
	);
	assert.deepEqual(calls, [
		["run", "test:pkg", "ai", "coding-agent", "desktop", "runtime-node", "runtime-storage"],
		["scripts/quality/run-vitest.mjs", "--run", ...selectSshPlatformSuites("win32").map((file) => `packages/ssh-transport/src/${file}`)],
		["../../scripts/quality/run-vitest.mjs", "--run", ...WINDOWS_DESKTOP_SSH_SUITES, "--reporter=verbose"],
	]);
	assert.throws(
		() =>
			testReleaseSource("upstream/v0.5.59", controllerSha, {
				execute,
				run: () => {
					throw new Error("must not run");
				},
			}),
		/checkout differs/,
	);
	assert.equal(testReleaseSource("upstream/v0.5.59", sourceSha, { execute, run: () => 23 }), 23);
});
