import assert from "node:assert/strict";
import test from "node:test";
import { testPrSource } from "../../../scripts/flowstoken/test-pr-source.mjs";

function harness(before = "v0.5.59", after = "v0.5.60") {
	const calls = [];
	const options = {
		execute: (command, args) => {
			calls.push([command, args]);
			return args[0] === "show" ? before : "base-sha";
		},
		read: () => after,
		changed: (args) => {
			calls.push(["changed", args]);
			return 7;
		},
		run: (args) => {
			calls.push(["run", args]);
			return 0;
		},
		ssh: () => {
			calls.push(["ssh"]);
			return 0;
		},
	};
	return { calls, options };
}

test("ordinary changes keep targeted selection and preserve its failure", () => {
	const { calls, options } = harness("v0.5.60");
	assert.equal(testPrSource("base", options), 7);
	assert.deepEqual(calls.at(-1), ["changed", ["--base", "base"]]);
	assert.equal(
		calls.some(([command]) => command === "run"),
		false,
	);
});

test("published upstream changes run all workspaces and native SSH after proving ancestry", () => {
	const { calls, options } = harness();
	assert.equal(testPrSource("base", options), 0);
	assert.deepEqual(calls.slice(-2), [["run", ["run", "test:full"]], ["ssh"]]);
	assert.deepEqual(calls[3], ["git", ["merge-base", "--is-ancestor", "refs/tags/upstream/v0.5.60", "HEAD"]]);
});

test("a forged marker without the upstream ancestor cannot choose a different test gate", () => {
	const { calls, options } = harness();
	const execute = options.execute;
	options.execute = (command, args) => {
		if (args.includes("--is-ancestor")) throw new Error("missing ancestor");
		return execute(command, args);
	};
	assert.throws(() => testPrSource("base", options), /missing ancestor/);
	assert.equal(
		calls.some(([command]) => command === "run"),
		false,
	);
});

test("workspace failure stops without hiding it behind a successful SSH check", () => {
	const { calls, options } = harness();
	options.run = () => 9;
	assert.equal(testPrSource("base", options), 9);
	assert.equal(
		calls.some(([command]) => command === "ssh"),
		false,
	);
});

test("missing base, malformed marker and SSH failures are never successful", () => {
	const { options } = harness("v0.5.59", "not-a-version");
	assert.throws(() => testPrSource(undefined, options), /base/);
	assert.throws(() => testPrSource("base", options), /marker/);
	const valid = harness().options;
	valid.ssh = () => 12;
	assert.equal(testPrSource("base", valid), 12);
});
