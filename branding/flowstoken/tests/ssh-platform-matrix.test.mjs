import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertSshPlatformSelection, discoverSshSuites, selectSshPlatformSuites, testSshPlatform,
} from "../../../scripts/flowstoken/test-ssh-platform.mjs";

const portable = [
	"askpass.test.ts", "directory-listing.test.ts", "node-process-runner.test.ts", "project-uri.test.ts",
	"remote-command.test.ts", "remote-listeners.test.ts", "remote-pty.test.ts", "ssh-config-aliases.test.ts",
	"ssh-connection.test.ts",
].sort();
const native = [
	"helper.e2e.test.ts", "remote-command-signals.test.ts", "remote-command.posix.test.ts",
	"remote-listeners.posix.test.ts", "ssh-connection.loopback.test.ts",
].sort();
const files = [...portable, ...native].sort();

test("every actual SSH suite is classified; pure and native Node contracts run on all three client OSes", () => {
	assert.deepEqual(discoverSshSuites(), files);
	assert.deepEqual(selectSshPlatformSuites("win32"), portable);
	for (const platform of ["darwin", "linux"]) assert.deepEqual(selectSshPlatformSuites(platform), files);
});

test("new, missing or unsupported suites fail closed rather than silently omitting coverage", () => {
	assert.throws(() => selectSshPlatformSuites("win32", [...files, "future.test.ts"]), /unclassified: future/);
	assert.throws(() => selectSshPlatformSuites("linux", files.filter((file) => file !== "helper.e2e.test.ts")), /missing: helper/);
	assert.throws(() => selectSshPlatformSuites("freebsd", files), /Unsupported/);
});

test("discovery catches new nested JS/spec suites before platform classification", () => {
	const root = mkdtempSync(join(tmpdir(), "ssh-matrix-"));
	try {
		const directory = join(root, "packages/ssh-transport/src/nested");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "future.spec.mjs"), "");
		assert.deepEqual(discoverSshSuites(root), ["nested/future.spec.mjs"]);
		assert.throws(() => selectSshPlatformSuites("win32", discoverSshSuites(root)), /unclassified: nested\/future/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("coverage mutations cannot drop native Windows cancellation or misclassify Unix signals as Windows proof", () => {
	assert.throws(() => assertSshPlatformSelection("win32", portable.filter((file) => file !== "node-process-runner.test.ts"), files), /Incomplete/);
	assert.throws(() => assertSshPlatformSelection("win32", [...portable, "remote-command-signals.test.ts"], files), /unsafe/);
	assert.throws(() => assertSshPlatformSelection("linux", portable, files), /Incomplete/);
});

test("Windows executes its native suites and every real Git Bash desktop operation, without Go/POSIX signals", () => {
	const calls = [];
	const result = testSshPlatform({
		platform: "win32", files,
		run: (args, options) => { calls.push({ args, options }); return 0; },
		command: () => { throw new Error("Windows must not execute a POSIX helper"); },
	});
	assert.equal(result, 0);
	assert.deepEqual(calls[0].args, ["scripts/quality/run-vitest.mjs", "--run", ...portable.map((file) => `packages/ssh-transport/src/${file}`)]);
	for (const file of ["loopback-fixture.test.ts", "command-spawner.remote.test.ts", "remote-command-runner.test.ts", "resource-runtime.remote.test.ts", "filesystem-service.remote-flow.test.ts"]) {
		assert.ok(calls[1].args.some((argument) => argument.endsWith(file)));
	}
	assert.equal(calls[1].options.env.VETTA_LOOPBACK_TRACE, "1");
});

test("both native POSIX hosts execute all SSH suites and real Go helper/PTY tests", () => {
	for (const platform of ["linux", "darwin"]) {
		const calls = [];
		assert.equal(testSshPlatform({
			platform, files, prerequisites: () => {},
			run: (args) => { calls.push(args); return 0; },
			command: (program, args) => { calls.push([program, ...args]); return 0; },
		}), 0);
		assert.deepEqual(calls[0], ["scripts/quality/run-vitest.mjs", "--run", ...files.map((file) => `packages/ssh-transport/src/${file}`)]);
		assert.deepEqual(calls[1], ["go", "test", "-count=1", "./internal/server"]);
	}
});

test("native prerequisites and failures at every platform phase remain fatal", () => {
	assert.throws(() => testSshPlatform({ platform: "linux", files, prerequisites: () => { throw new Error("missing Go"); } }), /missing Go/);
	let invoked = 0;
	assert.equal(testSshPlatform({ platform: "win32", files, run: () => { invoked++; return 17; } }), 17);
	assert.equal(invoked, 1);
	assert.equal(testSshPlatform({ platform: "win32", files, run: () => ++invoked === 2 ? 0 : 23 }), 23);
	assert.equal(testSshPlatform({ platform: "linux", files, prerequisites: () => {}, run: () => 0, command: () => 29 }), 29);
});
