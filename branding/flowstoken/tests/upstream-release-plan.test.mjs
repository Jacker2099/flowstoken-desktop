import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { planUpstreamRelease } from "../../../scripts/flowstoken/upstream-release-plan.mjs";

const upstream = { tag_name: "v0.5.60", draft: false, prerelease: false };
const sha = "a".repeat(40);

test("a new formal upstream release enters merge while preview or invalid releases are refused", () => {
	assert.equal(planUpstreamRelease({ upstream, synced: "v0.5.59", sha }), "merge");
	for (const change of [
		{ draft: true },
		{ prerelease: true },
		{ tag_name: "v0.5.60-beta.1" },
		{ tag_name: 'v0.5.60"; echo unexpected' },
	]) {
		assert.throws(() => planUpstreamRelease({ upstream: { ...upstream, ...change }, synced: "v0.5.59", sha }));
	}
});

test("retrying an already synced version never merges or increments its version again", () => {
	for (const published of [null, { draft: true }]) {
		assert.equal(planUpstreamRelease({ upstream, synced: upstream.tag_name, published, sha }), "release");
	}
	assert.equal(planUpstreamRelease({ upstream, synced: upstream.tag_name, published: { draft: false }, sha }), "skip");
});

test("an active release of this commit suppresses duplicate dispatch, while a completed failure can retry", () => {
	const base = { upstream, synced: upstream.tag_name, sha };
	assert.equal(planUpstreamRelease({ ...base, activeRuns: [{ head_sha: sha, status: "in_progress" }] }), "skip");
	assert.equal(planUpstreamRelease({ ...base, activeRuns: [{ head_sha: sha, status: "queued" }] }), "skip");
	assert.equal(
		planUpstreamRelease({ ...base, activeRuns: [{ head_sha: sha, status: "completed", conclusion: "failure" }] }),
		"release",
	);
});

test("sync dispatch, related tests and publication integrity remain required workflow gates", () => {
	const root = resolve(import.meta.dirname, "../../..");
	const require = createRequire(resolve(root, "apps/desktop/package.json"));
	const { parse } = require("yaml");
	const outer = parse(readFileSync(resolve(root, ".github/workflows/flowstoken-release.yml"), "utf8"));
	const inner = parse(readFileSync(resolve(root, ".github/workflows/desktop-release.yml"), "utf8"));
	const sync = parse(readFileSync(resolve(root, ".github/workflows/flowstoken-upstream-sync.yml"), "utf8"));
	assert.equal(outer.jobs.build.needs, "validate-related");
	assert.ok(outer.jobs["validate-related"].steps.some((step) => step.run?.includes("test-flowstoken-related.mjs")));
	const build = inner.jobs.build.steps;
	assert.ok(
		build.findIndex((step) => step.name === "Record checkpoint provenance and file hashes") <
			build.findIndex((step) => step.name === "Archive build checkpoint"),
	);
	assert.ok(outer.jobs.publish.steps.some((step) => step.run?.includes("--mode check-checkpoint")));
	assert.ok(outer.jobs.publish.steps.some((step) => step.run?.includes("--mode release")));
	assert.ok(
		outer.jobs.publish.steps
			.find((step) => step.name === "Publish GitHub Release")
			.run.includes("publish-release.mjs"),
	);
	const ship = sync.jobs.sync.steps.find((step) => step.name === "Ship it");
	assert.match(ship.run, /expected_sha="\$RELEASE_SHA"/);
	assert.match(ship.if, /resume_release/);
	const failure = sync.jobs.sync.steps.find((step) => step.name === "Record the failed attempt");
	assert.doesNotMatch(failure.run, /git push -f|git add -A/);
	assert.match(failure.run, /GITHUB_RUN_ID.*GITHUB_RUN_ATTEMPT/);
});
