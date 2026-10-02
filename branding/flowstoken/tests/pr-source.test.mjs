import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { testPrSource } from "../../../scripts/flowstoken/test-pr-source.mjs";
import { selectSshPlatformSuites, WINDOWS_DESKTOP_SSH_SUITES } from "../../../scripts/flowstoken/test-ssh-platform.mjs";

function harness(before = "v0.5.59", after = "v0.5.60") {
	const calls = [];
	const options = {
		execute: (command, args) => {
			calls.push([command, args]);
			if (args[0] === "show" && args[1].endsWith(":apps/desktop/package.json"))
				return JSON.stringify({ version: "0.6.6" });
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

function releaseFixture(t, { version = "0.6.7", emptyForkDiff = false } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "flowstoken-pr-source-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const git = (args) =>
		execFileSync(
			"git",
			[
				"-c",
				"commit.gpgsign=false",
				"-c",
				"tag.gpgsign=false",
				"-c",
				`core.hooksPath=${join(directory, "no-hooks")}`,
				"-c",
				"user.name=FlowsToken test",
				"-c",
				"user.email=fixture@example.invalid",
				...args,
			],
			{ cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
	const files = new Set();
	const write = (path, contents) => {
		const file = join(directory, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
		files.add(path);
	};
	const writeVersion = (value) => write("apps/desktop/package.json", JSON.stringify({ version: value }));
	const commit = () => {
		git(["add", "--", ...files]);
		git(["commit", "--quiet", "-m", "owned test fixture"]);
		return git(["rev-parse", "HEAD"]);
	};
	git(["init", "--quiet"]);
	write("branding/flowstoken/UPSTREAM_SYNCED", "v0.5.60\n");
	writeVersion("0.5.60");
	commit();
	git(["tag", "upstream/v0.5.60"]);
	writeVersion("0.6.6");
	const base = commit();
	writeVersion(version);
	write("packages/runtime-core/src/pr-source-fixture.ts", "export const fixture = true;\n");
	const head = commit();
	if (emptyForkDiff) git(["tag", "-f", "upstream/v0.5.60", "HEAD"]);
	const calls = [];
	const options = {
		// Git is real; only fetching the already-installed fixture tag and child test runners are external fakes.
		execute: (command, args) => {
			assert.equal(command, "git");
			calls.push([command, args]);
			return args[0] === "fetch" ? "" : git(args);
		},
		read: () => git(["show", "HEAD:branding/flowstoken/UPSTREAM_SYNCED"]),
		platform: "win32",
		changed: (args) => {
			calls.push(["changed", args]);
			return 7;
		},
		run: (args) => {
			calls.push(["run", args]);
			return 0;
		},
		ssh: () => {
			calls.push(["extra-ssh"]);
			return 0;
		},
	};
	return { base, head, git, calls, options, writeVersion, commit };
}

test("a committed desktop version change executes complete release workspaces and native SSH once", (t) => {
	const { base, head, calls, options } = releaseFixture(t);
	assert.equal(testPrSource(base, options), 0);
	const runs = calls.filter(([command]) => command === "run").map(([, args]) => args);
	assert.deepEqual(runs, [
		["run", "test:pkg", "ai", "coding-agent", "desktop", "runtime-core", "runtime-node", "runtime-storage"],
		[
			"scripts/quality/run-vitest.mjs",
			"--run",
			...selectSshPlatformSuites("win32").map((file) => `packages/ssh-transport/src/${file}`),
		],
		["../../scripts/quality/run-vitest.mjs", "--run", ...WINDOWS_DESKTOP_SSH_SUITES, "--reporter=verbose"],
	]);
	assert.equal(
		calls.some(([command]) => command === "changed" || command === "extra-ssh"),
		false,
	);
	assert.ok(
		calls.some(([command, args]) => command === "git" && args[0] === "diff" && args.includes("upstream/v0.5.60")),
	);
	assert.equal(head.length, 40);
});

test("an empty upstream diff still executes the complete client floor before native SSH", (t) => {
	const { base, calls, options } = releaseFixture(t, { emptyForkDiff: true });
	assert.equal(testPrSource(base, options), 0);
	const runs = calls.filter(([command]) => command === "run").map(([, args]) => args);
	assert.deepEqual(runs[0], ["run", "test:pkg", "ai", "coding-agent", "desktop", "runtime-node", "runtime-storage"]);
	assert.equal(runs.length, 3);
});

test("a working-tree version edit does not change the committed PR source gate", (t) => {
	const { base, calls, options, writeVersion } = releaseFixture(t, { version: "0.6.6" });
	writeVersion("0.6.7");
	assert.equal(testPrSource(base, options), 7);
	assert.deepEqual(calls.at(-1), ["changed", ["--base", base]]);
	assert.equal(
		calls.some(([command]) => command === "run"),
		false,
	);
});

test("release preparation rejects a checkout identity change before running a test suite", (t) => {
	const { base, options, calls } = releaseFixture(t);
	const execute = options.execute;
	let identities = 0;
	options.execute = (command, args) => {
		if (args[0] === "rev-parse" && args[1] === "HEAD" && ++identities === 2) return base;
		return execute(command, args);
	};
	assert.throws(() => testPrSource(base, options), /checkout differs/);
	assert.equal(
		calls.some(([command]) => command === "run"),
		false,
	);
});

test("release preparation cannot replace a missing verified upstream baseline with targeted tests", (t) => {
	const { base, git, calls, options } = releaseFixture(t);
	git(["tag", "-d", "upstream/v0.5.60"]);
	assert.throws(() => testPrSource(base, options));
	assert.equal(
		calls.some(([command]) => command === "run" || command === "changed"),
		false,
	);
});

test("release preparation rejects a missing committed desktop version", (t) => {
	const { base, calls, options, writeVersion, commit } = releaseFixture(t);
	writeVersion(undefined);
	commit();
	assert.throws(() => testPrSource(base, options), /desktop version/i);
	assert.equal(
		calls.some(([command]) => command === "run" || command === "changed"),
		false,
	);
});

for (const [stage, code, expectedRuns] of [
	["workspace", 23, 1],
	["transport", 17, 2],
	["host", 19, 3],
]) {
	test(`release preparation preserves ${stage} failure without a second test gate`, (t) => {
		const { base, calls, options } = releaseFixture(t);
		options.run = (args) => {
			calls.push(["run", args]);
			return (stage === "workspace" && args[1] === "test:pkg") ||
				(stage === "transport" && args[0] === "scripts/quality/run-vitest.mjs") ||
				(stage === "host" && args[0] === "../../scripts/quality/run-vitest.mjs")
				? code
				: 0;
		};
		assert.equal(testPrSource(base, options), code);
		assert.equal(calls.filter(([command]) => command === "run").length, expectedRuns);
		assert.equal(
			calls.some(([command]) => command === "changed" || command === "extra-ssh"),
			false,
		);
	});
}

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
