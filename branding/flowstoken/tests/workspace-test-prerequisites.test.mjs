import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TESTABLE_PACKAGES } from "../../../scripts/quality/lib.mjs";
import { testPrerequisites } from "../../../scripts/flowstoken/workspace-test-prerequisites.mjs";

const testScriptOf = (dir) => JSON.parse(readFileSync(new URL(`../../../${dir}/package.json`, import.meta.url), "utf8")).scripts.test;

test("a build step before the Vitest runner is a prerequisite the related-test gate must run", () => {
	assert.deepEqual(testPrerequisites("bun run build:runner && bun ../../../../scripts/quality/run-vitest.mjs --run"), [
		["run", "build:runner"],
	]);
});

test("a plain Vitest test script has no prerequisites", () => {
	assert.deepEqual(testPrerequisites("bun ../../scripts/quality/run-vitest.mjs --run"), []);
});

test("a non-bun step before Vitest is refused instead of silently skipped", () => {
	assert.throws(() => testPrerequisites("make fixtures && bun run-vitest.mjs --run", "apps/x"), /apps\/x: unsupported test prerequisite "make fixtures"/);
});

test("every workspace test script in the repo has prerequisites the gate can run", () => {
	for (const dir of Object.values(TESTABLE_PACKAGES)) assert.doesNotThrow(() => testPrerequisites(testScriptOf(dir), dir), dir);
	assert.deepEqual(testPrerequisites(testScriptOf("packages/plugins/presets/vetta-ui-design")), [["run", "build:runner"]]);
});
