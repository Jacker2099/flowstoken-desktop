import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runBun, runCommand } from "../quality/lib.mjs";

const directory = "packages/ssh-transport/src";

// These contracts run on every client OS. Native Windows processes use Windows PIDs and taskkill.
export const PORTABLE_SSH_SUITES = Object.freeze([
	"askpass.test.ts", "directory-listing.test.ts", "node-process-runner.test.ts", "project-uri.test.ts",
	"remote-command.test.ts", "remote-listeners.test.ts", "remote-pty.test.ts", "ssh-config-aliases.test.ts",
	"ssh-connection.test.ts",
]);

// Real remote endpoint semantics require native POSIX ps, signals, permissions, PTY and a POSIX Go helper.
export const POSIX_SSH_SUITES = Object.freeze([
	"helper.e2e.test.ts", "remote-command.posix.test.ts", "remote-command-signals.test.ts",
	"remote-listeners.posix.test.ts", "ssh-connection.loopback.test.ts",
]);

export const WINDOWS_DESKTOP_SSH_SUITES = Object.freeze([
	"src/main/ssh/loopback-fixture.test.ts", "src/main/plugins/command-spawner.remote.test.ts",
	"src/main/plugins/remote-command-runner.test.ts", "src/main/agent-runtime/resource-runtime.remote.test.ts",
	"src/main/filesystem/filesystem-service.remote-flow.test.ts",
]);

export function discoverSshSuites(root = process.cwd()) {
	return readdirSync(join(root, directory), { recursive: true })
		.map((file) => file.replaceAll("\\", "/"))
		.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
		.sort();
}

function assertInventory(files) {
	const classified = [...PORTABLE_SSH_SUITES, ...POSIX_SSH_SUITES];
	if (new Set(classified).size !== classified.length) throw new Error("SSH platform matrix classifies a suite twice");
	const unknown = files.filter((file) => !classified.includes(file));
	const missing = classified.filter((file) => !files.includes(file));
	if (unknown.length || missing.length) {
		throw new Error(`SSH platform matrix mismatch; unclassified: ${unknown.join(", ")}; missing: ${missing.join(", ")}`);
	}
}

function expectedSuites(platform) {
	if (!["win32", "darwin", "linux"].includes(platform)) throw new Error(`Unsupported SSH client test platform: ${platform}`);
	return [...PORTABLE_SSH_SUITES, ...(platform === "win32" ? [] : POSIX_SSH_SUITES)].sort();
}

export function assertSshPlatformSelection(platform, selected, files = discoverSshSuites()) {
	assertInventory(files);
	const expected = expectedSuites(platform);
	if (new Set(selected).size !== selected.length || selected.length !== expected.length ||
		selected.some((file) => !expected.includes(file))) {
		throw new Error(`Incomplete or unsafe SSH suite selection for ${platform}`);
	}
}

export function selectSshPlatformSuites(platform = process.platform, files = discoverSshSuites()) {
	const selected = expectedSuites(platform);
	assertSshPlatformSelection(platform, selected, files);
	return selected;
}

function requireNativeTools(platform) {
	if (platform === "win32") return;
	if (!existsSync("/bin/sh")) throw new Error("Native POSIX SSH gate requires /bin/sh");
	try {
		execFileSync("go", ["version"], { stdio: "pipe" });
	} catch {
		throw new Error("Native POSIX SSH gate requires Go; helper tests must not silently skip");
	}
}

export function testSshPlatform({
	platform = process.platform, root = process.cwd(), files = discoverSshSuites(root),
	run = runBun, command = runCommand, prerequisites = requireNativeTools,
} = {}) {
	const selected = selectSshPlatformSuites(platform, files);
	prerequisites(platform);
	console.info(`[ssh-platform] ${platform}: ${selected.join(", ")}`);
	const transport = run(["scripts/quality/run-vitest.mjs", "--run", ...selected.map((file) => `${directory}/${file}`)]);
	if (transport !== 0) return transport;
	if (platform === "win32") {
		for (const file of WINDOWS_DESKTOP_SSH_SUITES) {
			if (!existsSync(join(root, "apps/desktop", file))) throw new Error(`Missing Windows SSH contract: ${file}`);
		}
		return run(["../../scripts/quality/run-vitest.mjs", "--run", ...WINDOWS_DESKTOP_SSH_SUITES, "--reporter=verbose"], {
			cwd: join(root, "apps/desktop"), env: { VETTA_LOOPBACK_TRACE: "1" },
		});
	}
	// This exercises the real helper PTY/stdio lifecycle; remote-pty.test.ts is a portable adapter contract.
	return command("go", ["test", "-count=1", "./internal/server"], { cwd: join(root, "apps/ssh-helper") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try { process.exitCode = testSshPlatform(); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
