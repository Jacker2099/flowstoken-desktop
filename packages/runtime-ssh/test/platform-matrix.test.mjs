import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import config from "../vitest.config.ts";
import { discoverRuntimeSshSuites, requireNativeRuntimeSshTools, selectRuntimeSshSuites } from "./platform-matrix.mjs";

const portable = [
	"src/project-resource-paths.test.ts",
	"src/ssh-tool-environment.test.ts",
	"test/platform-matrix.test.mjs",
];
const posix = [
	"src/project-resource-access.test.ts",
	"src/remote-file-tool-bridge.test.ts",
	"src/ssh-background-command-host.test.ts",
	"src/ssh-edit-conflict.test.ts",
	"src/ssh-search-tools.test.ts",
];
const all = [...portable, ...posix].sort();
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("Windows selects portable construction/path contracts and excludes every native endpoint", () => {
	expect(selectRuntimeSshSuites("win32")).toEqual(portable);
});

it.each(["darwin", "linux"])("%s requires the full portable and native POSIX suite inventory", (platform) => {
	expect(selectRuntimeSshSuites(platform)).toEqual(all);
});

it("the real package config and static test script select the supported contracts without an empty-pass escape", () => {
	expect(config.test.include).toEqual(process.platform === "win32" ? portable : all);
	expect(config.test.passWithNoTests).toBe(false);
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	expect(manifest.scripts.test).toBe("bun ../../scripts/quality/run-vitest.mjs --run");
});

it("rejects unsupported platforms, duplicate inventories and missing suites", () => {
	expect(() => selectRuntimeSshSuites("aix", all)).toThrow("Unsupported");
	expect(() => selectRuntimeSshSuites("win32", [...all, portable[0]])).toThrow("matrix mismatch");
	for (const file of all)
		expect(() =>
			selectRuntimeSshSuites(
				"linux",
				all.filter((item) => item !== file),
			),
		).toThrow(file);
});

it("discovers nested new suite extensions and fails closed while excluding dependency/build outputs", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-ssh-inventory-"));
	roots.push(root);
	for (const file of [...all, "dist/ignored.test.js", "node_modules/ignored.test.ts"]) {
		const path = join(root, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "");
	}
	expect(discoverRuntimeSshSuites(root)).toEqual(all);
	for (const file of ["src/nested/unclassified.spec.tsx", "test/new.test.mjs", "test/new.test.cjs"]) {
		const path = join(root, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "");
		expect(() => selectRuntimeSshSuites("win32", discoverRuntimeSshSuites(root))).toThrow(file);
		rmSync(path);
	}
});

it("Windows prerequisites never execute POSIX shell, Go, rg or fd probes", () => {
	const run = vi.fn(() => {
		throw new Error("Unexpected native dependency probe");
	});
	const exists = vi.fn(() => false);
	requireNativeRuntimeSshTools("win32", { run, exists });
	expect(run).not.toHaveBeenCalled();
	expect(exists).not.toHaveBeenCalled();
});

it.each(["/bin/sh", "go", "rg", "fd"])("a missing %s makes the POSIX gate fail rather than skip", (missing) => {
	const run = (command) => {
		if (command === missing || (missing === "fd" && command === "fdfind")) throw new Error("Missing native tool");
		return Buffer.from("installed");
	};
	expect(() => requireNativeRuntimeSshTools("linux", { run, exists: () => missing !== "/bin/sh" })).toThrow(missing);
});

it("accepts Debian fdfind and requires an actual successful executable probe", () => {
	const commands = [];
	requireNativeRuntimeSshTools("linux", {
		exists: () => true,
		run: (command) => {
			commands.push(command);
			if (command === "fd") throw new Error("Missing fd alias");
			return Buffer.from("installed");
		},
	});
	expect(commands).toEqual(["go", "rg", "fd", "fdfind"]);
});
