import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set(["node_modules", "dist", ".git", ".turbo", ".cache"]);

export const PORTABLE_RUNTIME_SSH_SUITES = Object.freeze([
	"src/ssh-tool-environment.test.ts",
	"src/project-resource-paths.test.ts",
	"test/platform-matrix.test.mjs",
]);
export const POSIX_RUNTIME_SSH_SUITES = Object.freeze([
	"src/project-resource-access.test.ts",
	"src/remote-file-tool-bridge.test.ts",
	"src/ssh-search-tools.test.ts",
	"src/ssh-background-command-host.test.ts",
	"src/ssh-edit-conflict.test.ts",
]);

export function discoverRuntimeSshSuites(root = packageRoot) {
	const files = [];
	function visit(directory, prefix = "") {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = `${prefix}${entry.name}`;
			if (entry.isDirectory()) {
				if (!ignoredDirectories.has(entry.name)) visit(join(directory, entry.name), `${path}/`);
			} else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
		}
	}
	visit(root);
	return files.sort();
}

export function selectRuntimeSshSuites(platform = process.platform, files = discoverRuntimeSshSuites()) {
	if (!["win32", "darwin", "linux"].includes(platform))
		throw new Error(`Unsupported runtime-ssh test platform: ${platform}`);
	const classified = [...PORTABLE_RUNTIME_SSH_SUITES, ...POSIX_RUNTIME_SSH_SUITES];
	if (new Set(classified).size !== classified.length) throw new Error("runtime-ssh suite classified twice");
	const unknown = files.filter((file) => !classified.includes(file));
	const missing = classified.filter((file) => !files.includes(file));
	if (unknown.length || missing.length || new Set(files).size !== files.length) {
		throw new Error(
			`runtime-ssh matrix mismatch; unclassified: ${unknown.join(", ")}; missing: ${missing.join(", ")}`,
		);
	}
	return [...PORTABLE_RUNTIME_SSH_SUITES, ...(platform === "win32" ? [] : POSIX_RUNTIME_SSH_SUITES)].sort();
}

export function requireNativeRuntimeSshTools(
	platform = process.platform,
	{ run = execFileSync, exists = existsSync } = {},
) {
	if (platform === "win32") return;
	if (platform !== "darwin" && platform !== "linux")
		throw new Error(`Unsupported runtime-ssh test platform: ${platform}`);
	if (!exists("/bin/sh")) throw new Error("Native runtime-ssh tests require /bin/sh");
	for (const [command, args] of [
		["go", ["version"]],
		["rg", ["--version"]],
	]) {
		try {
			run(command, args, { stdio: "pipe" });
		} catch {
			throw new Error(`Native runtime-ssh tests require ${command}; tests must not silently skip`);
		}
	}
	for (const command of ["fd", "fdfind"]) {
		try {
			run(command, ["--version"], { stdio: "pipe" });
			return;
		} catch {
			/* Debian provides fdfind; production supports both executable names. */
		}
	}
	throw new Error("Native runtime-ssh tests require fd or fdfind; tests must not silently skip");
}
