import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShellArgument } from "@vetta/ssh-transport";
import {
	acceptOwnedJobReady,
	createLoopbackTestScope,
	createOwnedJobFromNativeCallsForTests,
	createShellLoopbackRunner,
	loopbackCommandShellBinary,
	loopbackRemotePath,
	loopbackShellBinary,
	stopOwnedJob,
	terminateWindowsLoopbackTree,
	waitForOwnedJobEmpty,
	waitForOwnedSupervisorLaunch,
} from "@vetta/ssh-transport/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
const ownedBoundaries: {
	scope: ReturnType<typeof createLoopbackTestScope>;
	runner: ReturnType<typeof createShellLoopbackRunner>;
}[] = [];

it("releases exactly the owned native handles on limit setup and assignment failure without allowing breakaway", () => {
	const closed: unknown[] = [],
		jobHandle = {},
		processHandle = {};
	let allowSetup = false,
		flags = 0;
	const api = {
		extendedSize: 144,
		flagsOffset: 16,
		CreateJob: () => jobHandle,
		SetInfo: (_handle: unknown, _kind: number, data: Buffer) => {
			flags = data.readUInt32LE(16);
			return allowSetup ? 1 : 0;
		},
		Close: (handle: unknown) => {
			closed.push(handle);
			return 1;
		},
		Error: () => 5,
		OpenProcess: () => processHandle,
		Times: (_handle: unknown, birth: { low: number; high: number }) => {
			birth.low = 123;
			birth.high = 0;
			return 1;
		},
		Wait: () => 258,
		Assign: () => 0,
	};
	expect(() => createOwnedJobFromNativeCallsForTests(api)).toThrow("limits failed");
	expect(closed).toEqual([jobHandle]);
	expect(flags).toBe(0x2000);
	allowSetup = true;
	closed.length = 0;
	const job = createOwnedJobFromNativeCallsForTests(api);
	expect(() => job.assign(200, "123")).toThrow("Assign private");
	expect(closed).toEqual([processHandle]);
	job.close();
	job.close();
	expect(closed).toEqual([processHandle, jobHandle]);
});

it("does not launch or assign a stopped supervisor before its ready handshake", () => {
	const job = { assign: vi.fn(), terminate: vi.fn(), activeProcesses: () => 0, close: vi.fn() };
	const peer = { pid: 200, alive: () => true, killOwned: vi.fn(), launch: vi.fn() };
	const state = { job, assigned: false, stopped: false };
	stopOwnedJob(state, peer);
	expect(peer.killOwned).toHaveBeenCalledOnce();
	expect(job.terminate).not.toHaveBeenCalled();
	expect(acceptOwnedJobReady(state, peer, { type: "owned-supervisor-ready", pid: 200, creationTicks: "birth" })).toBe(
		false,
	);
	expect(job.assign).not.toHaveBeenCalled();
	expect(peer.launch).not.toHaveBeenCalled();
});

it("does not start Bash after an identity mismatch or native assignment failure", () => {
	const job = {
		assign: vi.fn(() => {
			throw new Error("Assign failed");
		}),
		terminate: vi.fn(),
		activeProcesses: () => 0,
		close: vi.fn(),
	};
	const peer = { pid: 200, alive: () => true, killOwned: vi.fn(), launch: vi.fn() };
	const state = { job, assigned: false, stopped: false };
	expect(() =>
		acceptOwnedJobReady(state, peer, { type: "owned-supervisor-ready", pid: 201, creationTicks: "birth" }),
	).toThrow("identity");
	expect(job.assign).not.toHaveBeenCalled();
	expect(() =>
		acceptOwnedJobReady(state, peer, { type: "owned-supervisor-ready", pid: 200, creationTicks: "birth" }),
	).toThrow("Assign failed");
	expect(state.assigned).toBe(false);
	expect(peer.launch).not.toHaveBeenCalled();
});

it("does not accept wrapper close while its owned job still contains a process", async () => {
	vi.useFakeTimers();
	try {
		let count = 1,
			completed = false;
		const pending = waitForOwnedJobEmpty({ activeProcesses: () => count }).then(() => {
			completed = true;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(completed).toBe(false);
		count = 0;
		await vi.advanceTimersByTimeAsync(5);
		await pending;
		expect(completed).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

it(
	"the actual Node supervisor exits on parent IPC disconnect before starting a shell",
	{ timeout: 30_000 },
	async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "owned-supervisor-disconnect-")));
		directories.push(directory);
		const marker = join(directory, "shell-started");
		const program = `const __name = (value) => value; (${waitForOwnedSupervisorLaunch.toString()})(process, () => require('node:fs').writeFileSync(${JSON.stringify(marker)},'started'), () => process.exit(1)); process.send({type:'ready'});`;
		const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let errors = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				child.once("message", () => resolve());
				child.once("error", reject);
				child.once("exit", () => reject(new Error(`Supervisor exited before ready: ${errors}`)));
			});
			const done = new Promise<number | null>((resolve) => child.once("exit", resolve));
			child.disconnect();
			expect(await done).toBe(1);
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
	},
);

it(
	"the actual Node supervisor preserves natural output and exit17 while the parent IPC stays connected",
	{ timeout: 30_000 },
	async () => {
		const program = `const __name=(value)=>value; (${waitForOwnedSupervisorLaunch.toString()})(process,()=>{const child=require('node:child_process').spawn(process.execPath,['-e',"process.stdout.write('natural-output');process.exitCode=17"],{stdio:['ignore','pipe','ignore']});child.stdout.pipe(process.stdout);child.on('close',code=>{process.exitCode=code;});},()=>process.exit(1));process.send({type:'ready'});`;
		const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
		let output = "",
			errors = "";
		child.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			errors += data.toString();
		});
		try {
			const done = new Promise<number | null>((resolve) => child.once("close", resolve));
			await new Promise<void>((resolve, reject) => {
				child.once("message", () => resolve());
				child.once("error", reject);
			});
			child.send({ type: "start-owned-shell" });
			expect(await done).toBe(17);
			expect(output).toBe("natural-output");
			expect(errors).toBe("");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
	},
);

function fixture(terminationDelayMs = 0, terminateOverride?: (child: ChildProcess) => void, trace?: boolean) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "vetta loopback shell ")));
	directories.push(directory);
	const script = join(directory, "fake ssh.sh");
	writeFileSync(script, 'for last; do :; done\nexec /bin/sh -c "$last"\n');
	const stopped: ChildProcess[] = [];
	const runner = createShellLoopbackRunner({
		shellBinary: loopbackShellBinary(),
		commandShellBinary: loopbackCommandShellBinary(),
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
	const scope = createLoopbackTestScope();
	scope.onClosing(() => runner.abortOwnedOperations());
	ownedBoundaries.push({ scope, runner });
	const ownedRunner = {
		...runner,
		run: (invocation: Parameters<typeof runner.run>[0]) => scope.step(() => runner.run(invocation)),
		open: (invocation: Parameters<NonNullable<typeof runner.open>>[0]) => {
			scope.assertOpen();
			const channel = runner.open?.(invocation);
			if (!channel) throw new Error("Owned channel unavailable");
			scope.onCleanup(async () => {
				channel.kill();
				await channel.exited;
			});
			return channel;
		},
	};
	return { directory, runner: ownedRunner, stopped };
}

afterEach(async () => {
	for (const { scope, runner } of ownedBoundaries.splice(0)) await scope.close(() => runner.waitForIdle());
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

describe("loopback remote shell boundary", { timeout: 60_000 }, () => {
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
				// This witness changes only on the real ChildProcess close event, including the Windows owned-job boundary.
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

	it("traces sanitized operation metadata and timing only when explicitly enabled", async () => {
		const events: string[] = [];
		let releaseShell: string | undefined;
		const release = () => {
			if (releaseShell) writeFileSync(releaseShell, "release");
		};
		vi.spyOn(console, "error").mockImplementation((value) => {
			const event = String(value);
			events.push(event);
			if (event.includes('"phase":"shell-start"')) release();
		});
		await fixture(0, undefined, false).runner.run({ argv: ["printf sensitive-command"] });
		expect(events).toEqual([]);
		const traced = fixture(0, undefined, true);
		if (process.platform === "win32") releaseShell = join(traced.directory, "trace-shell-release");
		const boundary = ownedBoundaries.at(-1);
		expect(boundary).toBeDefined();
		boundary?.scope.onClosing(release);
		// A short printf can exit before its native witness is sampled. Keep this
		// owned shell alive until the parent receives shell-start, without a timer.
		const command = releaseShell
			? `printf sensitive-command; while [ ! -f ${quoteShellArgument(loopbackRemotePath(releaseShell))} ]; do :; done`
			: "printf sensitive-command";
		try {
			await traced.runner.run({
				argv: [command],
				env: { PRIVATE_VALUE: "sensitive-env" },
			});
		} finally {
			release();
		}
		const witnessKeys = ["pid", "ppid", "image", "createdAt", "creationTicks", "active", "exitCode", "exitedAt"];
		const externalPhases = ["queue", "start", "spawn", "stdout-first", "exit", "close"];
		const parseEvent = (event: string) => {
			const match = /^\[loopback \d+\] ([a-z-]+) \d+ms (\{.*\})$/.exec(event);
			expect(match).not.toBeNull();
			const phase = match?.[1] ?? "";
			const details = JSON.parse(match?.[2] ?? "{}") as Record<string, unknown>;
			expect(details).toBeTypeOf("object");
			let keys: string[];
			switch (phase) {
				case "queue":
					keys = ["commandKind", "commandHash"];
					break;
				case "start":
					keys = [];
					break;
				case "spawn":
					keys = ["pid", "needsParent", "commandKind", "commandHash"];
					if (process.platform === "win32") keys.push("nativeCommandEndpoint");
					break;
				case "stdout-first":
					keys = ["bytes"];
					break;
				case "exit":
					keys = ["code", "signal"];
					break;
				case "close":
					keys = ["exitCode", "stdoutBytes"];
					break;
				case "native-start":
				case "native-exit":
					keys = witnessKeys;
					break;
				case "inner-native":
					keys =
						details.type === "owned-supervisor-ready"
							? ["type", "pid", "creationTicks"]
							: ["phase", ...witnessKeys];
					break;
				case "job-assigned":
					keys = ["pid", "activeProcesses"];
					break;
				case "job-empty":
					keys = ["activeProcesses"];
					break;
				default:
					throw new Error("Unexpected trace phase");
			}
			expect(Object.keys(details).sort()).toEqual([...keys].sort());
			if ("pid" in details) expect(Number.isSafeInteger(details.pid) && Number(details.pid) > 1).toBe(true);
			if ("creationTicks" in details) expect(details.creationTicks).toMatch(/^\d+$/);
			if ("commandHash" in details) expect(details.commandHash).toMatch(/^[a-f0-9]{16}$/);
			if ("commandKind" in details) expect(details.commandKind).toBe("execute");
			if ("image" in details) {
				expect(details.ppid === null || (Number.isSafeInteger(details.ppid) && Number(details.ppid) > 0)).toBe(
					true,
				);
				expect(details.image).toMatch(/\\(?:node|sh)\.exe$/i);
				expect(details.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
				expect(Number.isFinite(Date.parse(String(details.createdAt)))).toBe(true);
				expect(details.active).toBeTypeOf("boolean");
				if (details.active) expect([details.exitCode, details.exitedAt]).toEqual([null, null]);
				else {
					expect(details.exitCode).toBe(0);
					expect(details.exitedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
					expect(Date.parse(String(details.exitedAt))).toBeGreaterThanOrEqual(
						Date.parse(String(details.createdAt)),
					);
				}
			}
			for (const privateValue of ["sensitive-command", "sensitive-env", "PRIVATE_VALUE"]) {
				expect(event).not.toContain(privateValue);
			}
			return { phase, details };
		};
		const records = events.map(parseEvent);
		const phases = records.map(({ phase }) => phase);
		expect(phases.filter((phase) => externalPhases.includes(phase))).toEqual(externalPhases);
		if (process.platform === "win32") {
			const one = (phase: string, innerPhase?: string) => {
				const matching = records.filter(
					(record) => record.phase === phase && (!innerPhase || record.details.phase === innerPhase),
				);
				expect(matching).toHaveLength(1);
				return matching[0].details;
			};
			const before = (earlier: Record<string, unknown>, later: Record<string, unknown>) => {
				expect(records.findIndex(({ details }) => details === earlier)).toBeLessThan(
					records.findIndex(({ details }) => details === later),
				);
			};
			const started = one("native-start");
			const exited = one("native-exit");
			const assigned = one("job-assigned");
			const shellStarted = one("inner-native", "shell-start");
			const shellExited = one("inner-native", "shell-exit");
			const shellClosed = one("inner-native", "shell-close");
			expect(
				records.filter(({ phase }) => phase === "inner-native").map(({ details }) => details.phase ?? details.type),
			).toEqual(["wrapper-start", "owned-supervisor-ready", "shell-start", "shell-exit", "shell-close"]);
			expect(one("spawn")).toMatchObject({ pid: started.pid, needsParent: true, nativeCommandEndpoint: true });
			expect(one("inner-native", "wrapper-start")).toEqual({ phase: "wrapper-start", ...started });
			expect(records.find(({ details }) => details.type === "owned-supervisor-ready")?.details).toEqual({
				type: "owned-supervisor-ready",
				pid: started.pid,
				creationTicks: started.creationTicks,
			});
			expect(assigned.pid).toBe(started.pid);
			// Launch IPC is sent before this snapshot; the shell may already belong to the job.
			expect([1, 2]).toContain(assigned.activeProcesses);
			expect(started.active).toBe(true);
			before(assigned, shellStarted);
			expect(shellStarted).toMatchObject({ ppid: started.pid, active: true });
			for (const ended of [shellExited, shellClosed]) {
				expect(ended).toMatchObject({
					pid: shellStarted.pid,
					creationTicks: shellStarted.creationTicks,
					createdAt: shellStarted.createdAt,
					image: shellStarted.image,
					active: false,
					exitCode: 0,
				});
			}
			expect(exited).toMatchObject({
				pid: started.pid,
				creationTicks: started.creationTicks,
				createdAt: started.createdAt,
				image: started.image,
				active: false,
				exitCode: 0,
			});
			expect(one("exit")).toEqual({ code: 0, signal: null });
			expect(one("close")).toEqual({ exitCode: 0, stdoutBytes: Buffer.byteLength("sensitive-command") });
			expect(one("job-empty")).toEqual({ activeProcesses: 0 });
			before(one("close"), one("job-empty"));
			for (const privateValue of ["sensitive-command", "sensitive-env", "PRIVATE_VALUE"]) {
				expect(() =>
					parseEvent(
						`[loopback 1] native-start 0ms ${JSON.stringify({ ...started, image: `C:\\${privateValue}\\node.exe` })}`,
					),
				).toThrow();
			}
		} else {
			expect(phases).toEqual(externalPhases);
		}
		const queue = records[0].details;
		expect(() => parseEvent(`[loopback 1] queue 0ms ${JSON.stringify({ ...queue, unexpected: "extra" })}`)).toThrow();
		expect(() =>
			parseEvent(`[loopback 1] queue 0ms ${JSON.stringify({ ...queue, commandKind: "sensitive-command" })}`),
		).toThrow();
		expect(events.join("\n")).not.toContain("sensitive-command");
		expect(events.join("\n")).not.toContain("sensitive-env");
		expect(events.join("\n")).not.toContain("PRIVATE_VALUE");
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
