import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createShellLoopbackRunner,
	loopbackRemotePath,
	loopbackShellBinary,
	terminateWindowsLoopbackTree,
} from "@vetta/ssh-transport/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];

function fixture(terminationDelayMs = 0, terminateOverride?: (child: ChildProcess) => void, trace?: boolean) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "vetta loopback shell ")));
	directories.push(directory);
	const script = join(directory, "fake ssh.sh");
	writeFileSync(script, 'for last; do :; done\nexec /bin/sh -c "$last"\n');
	const stopped: ChildProcess[] = [];
	const runner = createShellLoopbackRunner({
		shellBinary: loopbackShellBinary(),
		scriptPath: loopbackRemotePath(script),
		baseEnv: { ...process.env, ...(trace === undefined ? {} : { VETTA_LOOPBACK_TRACE: trace ? "1" : "0" }) },
		terminateTree(child) {
			stopped.push(child);
			if (terminateOverride) {
				terminateOverride(child);
				return;
			}
			const terminate = (): void => {
				if (process.platform === "win32") terminateWindowsLoopbackTree(child);
				else child.kill("SIGTERM");
			};
			if (terminationDelayMs === 0) terminate();
			else setTimeout(terminate, terminationDelayMs);
		},
	});
	return { directory, runner, stopped };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function startOwnedProcess({ directory, runner }: ReturnType<typeof fixture>) {
	const program = join(directory, "owned boundary.cjs");
	writeFileSync(program, 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	const controller = new AbortController();
	let signalReady = (): void => {};
	const ready = new Promise<void>((resolve) => {
		signalReady = resolve;
	});
	const done = runner.run({
		argv: [`exec ${quote(loopbackRemotePath(process.execPath))} ${quote(loopbackRemotePath(program))}`],
		signal: controller.signal,
		onStdout: () => signalReady(),
	});
	// Error regressions intentionally reject before the final cleanup awaits this promise.
	void done.catch(() => {});
	return { ready, done, controller };
}

async function closeOwnedProcess(child: ChildProcess): Promise<void> {
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	if (process.platform === "win32") terminateWindowsLoopbackTree(child);
	else child.kill("SIGTERM");
	await closed;
}

// Fail narrowly and still enter finally to clean our real process if a queue regression hangs.
async function bounded<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("queued request did not settle")), 1000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("loopback remote shell boundary", () => {
	it("passes spaced script paths, quoted arguments and real stdin bytes through a shell", async () => {
		const { runner } = fixture();
		const result = await runner.run({
			argv: ["-T", "ignored-host", "cat; printf '%s' 'literal $HOME ; value'"],
			stdin: Buffer.from("input\n"),
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.from(result.stdout).toString()).toBe("input\nliteral $HOME ; value");
	});

	it("waits for an aborted owned process to close before running the concurrent remote cleanup request", async () => {
		const { directory, runner, stopped } = fixture(300);
		const liveFile = join(directory, "owned process alive");
		const program = join(directory, "owned process.cjs");
		writeFileSync(
			program,
			[
				'const fs = require("node:fs");',
				`const live = ${JSON.stringify(liveFile)};`,
				'fs.writeFileSync(live, "alive");',
				'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
			].join("\n"),
		);
		const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
		const controller = new AbortController();
		let cleanup: ReturnType<typeof runner.run> | undefined;
		const running = runner.run({
			argv: [`exec ${quote(loopbackRemotePath(process.execPath))} ${quote(loopbackRemotePath(program))}`],
			signal: controller.signal,
			onStdout: () => {
				// SshConnection starts its cleanup request before aborting the command.
				cleanup = runner.run({
					argv: [`[ ! -e ${quote(loopbackRemotePath(liveFile))} ] || exit 23; printf cleaned`],
				});
				controller.abort();
				// This witness changes only on the real ChildProcess close event, including Windows taskkill.
				stopped[0].once("close", () => rmSync(liveFile, { force: true }));
			},
		});
		await running;
		expect(stopped).toHaveLength(1);
		expect(stopped[0].exitCode !== null || stopped[0].signalCode !== null).toBe(true);
		await expect(cleanup).resolves.toMatchObject({ exitCode: 0, stdout: Buffer.from("cleaned") });
	});

	it.each([false, true])(
		"propagates termination failure to queued work without claiming close (async=%s)",
		async (asyncError) => {
			const error = new Error("test termination failed: private-path-or-command");
			const events: string[] = [];
			vi.spyOn(console, "error").mockImplementation((value) => {
				events.push(String(value));
			});
			const host = fixture(
				0,
				(child) => {
					if (asyncError) setImmediate(() => child.emit("error", error));
					else child.emit("error", error);
				},
				true,
			);
			const owned = startOwnedProcess(host);
			await owned.ready;
			const marker = join(host.directory, "must not start");
			const queued = host.runner.run({ argv: [`printf forbidden > '${loopbackRemotePath(marker)}'`] });
			void queued.catch(() => {});
			owned.controller.abort();
			try {
				await expect(bounded(owned.done)).rejects.toBe(error);
				await expect(bounded(queued)).rejects.toBe(error);
				expect(host.stopped[0].exitCode).toBeNull();
				expect(host.stopped[0].signalCode).toBeNull();
				expect(existsSync(marker)).toBe(false);
				expect(events.some((event) => event.includes("kill-error"))).toBe(true);
				expect(events.some((event) => event.includes("private-path-or-command"))).toBe(false);
			} finally {
				await closeOwnedProcess(host.stopped[0]);
			}
			await expect(host.runner.run({ argv: ["exit 0"] })).resolves.toMatchObject({ exitCode: 0 });
		},
	);

	it.each(["abort", "timeout"] as const)(
		"honors queued %s before the owned process closes, without starting a shell",
		async (reason) => {
			const host = fixture(0, () => {});
			const owned = startOwnedProcess(host);
			await owned.ready;
			owned.controller.abort();
			const controller = new AbortController();
			const marker = join(host.directory, "must not start");
			const queued = host.runner.run({
				argv: [`printf forbidden > '${loopbackRemotePath(marker)}'`],
				signal: controller.signal,
				...(reason === "timeout" ? { timeoutMs: 20 } : {}),
			});
			await Promise.resolve();
			if (reason === "abort") controller.abort();
			try {
				await expect(bounded(queued)).resolves.toMatchObject({
					exitCode: null,
					aborted: true,
					timedOut: reason === "timeout",
				});
				expect(host.stopped).toHaveLength(1);
				expect(host.stopped[0].exitCode).toBeNull();
				expect(existsSync(marker)).toBe(false);
			} finally {
				await closeOwnedProcess(host.stopped[0]);
				await owned.done;
			}
			expect(existsSync(marker)).toBe(false);
		},
	);

	it("traces only run ids, phases and elapsed time when explicitly enabled", async () => {
		const events: string[] = [];
		vi.spyOn(console, "error").mockImplementation((value) => {
			events.push(String(value));
		});
		await fixture(0, undefined, false).runner.run({ argv: ["printf sensitive-command"] });
		expect(events).toEqual([]);
		await fixture(0, undefined, true).runner.run({
			argv: ["printf sensitive-command"],
			env: { PRIVATE_VALUE: "sensitive-env" },
		});
		expect(events).toHaveLength(3);
		expect(events.every((event) => /^\[loopback \d+\] (queue|start|close) \d+ms$/.test(event))).toBe(true);
	});

	it("keeps the bidirectional helper channel available", async () => {
		const { runner } = fixture();
		let output = "";
		const channel = runner.open?.({
			argv: ["cat"],
			onStdout: (chunk) => {
				output += Buffer.from(chunk).toString();
			},
		});
		expect(channel).toBeDefined();
		channel?.write(Buffer.from("channel bytes"));
		channel?.end();
		await expect(channel?.exited).resolves.toMatchObject({ exitCode: 0 });
		expect(output).toBe("channel bytes");
	});

	it("preserves real remote command failures and never kills after close", async () => {
		const { runner, stopped } = fixture();
		const controller = new AbortController();
		const result = await runner.run({ argv: ["printf failure >&2; exit 17"], signal: controller.signal });
		expect(result).toMatchObject({ exitCode: 17, stderr: "failure", aborted: false });
		controller.abort();
		expect(stopped).toEqual([]);
	});

	it("does not spawn or kill for an already aborted request", async () => {
		const { runner, stopped } = fixture();
		const controller = new AbortController();
		controller.abort();
		const result = await runner.run({ argv: ["exit 1"], signal: controller.signal });
		expect(result).toMatchObject({ exitCode: null, aborted: true });
		expect(stopped).toEqual([]);
	});

	it.each([false, true])(
		"cancels its own live tree and waits for pipe closure (descendant=%s)",
		async (descendant) => {
			const { directory, runner, stopped } = fixture();
			const program = join(directory, "long command.cjs");
			writeFileSync(
				program,
				descendant
					? [
							'const { spawn } = require("node:child_process");',
							`const child = spawn(process.execPath, ["-e", ${JSON.stringify('process.stdout.write("ready\\n"); setInterval(() => {}, 1000);')}], { stdio: "inherit" });`,
							'process.on("SIGTERM", () => child.kill("SIGTERM"));',
							'child.on("exit", () => process.exit());',
						].join("\n")
					: 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
			);
			const controller = new AbortController();
			const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
			let output = "";
			const result = await runner.run({
				argv: [`exec ${quote(loopbackRemotePath(process.execPath))} ${quote(loopbackRemotePath(program))}`],
				signal: controller.signal,
				onStdout(chunk) {
					output += Buffer.from(chunk).toString();
					if (output.includes("ready\n")) controller.abort();
				},
			});
			expect(output).toBe("ready\n");
			expect(result.aborted).toBe(true);
			expect(stopped).toHaveLength(1);
			expect(stopped[0].exitCode !== null || stopped[0].signalCode !== null).toBe(true);
			terminateWindowsLoopbackTree(stopped[0]);
			expect(stopped).toHaveLength(1);
		},
	);
});
