import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createNodeSshProcessRunner } from "./node-process-runner.js";
import type { SshProcessResult, SshProcessRunner } from "./process-runner.js";

const WINDOWS_PARENT_WRAPPER = [
	'const { spawn } = require("node:child_process");',
	'const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });',
	"process.stdin.pipe(child.stdin);",
	"child.stdout.pipe(process.stdout);",
	"child.stderr.pipe(process.stderr);",
	'child.stdin.on("error", () => {});',
	'child.on("error", () => { process.stderr.write("Loopback shell failed to start\\n"); process.exitCode = 1; });',
	'child.on("close", (code) => { process.exitCode = code ?? 1; });',
].join("\n");

/** Test-only remote host boundary: execute the real shell script, not a simulated command parser. */
export function createShellLoopbackRunner(options: {
	readonly shellBinary: string;
	readonly scriptPath: string;
	readonly baseEnv: NodeJS.ProcessEnv;
	readonly terminateTree: (child: ChildProcess) => void;
}): SshProcessRunner {
	const closing = new Set<Promise<void>>();
	let nextRun = 0;
	const channelRunner = createNodeSshProcessRunner({ sshBinary: options.shellBinary, baseEnv: options.baseEnv });
	return {
		open(invocation) {
			if (!channelRunner.open) throw new Error("Loopback channel runner unavailable");
			return channelRunner.open({ ...invocation, argv: [options.scriptPath, ...invocation.argv] });
		},
		run(invocation) {
			const runId = ++nextRun;
			const startedAt = Date.now();
			const traceEnabled = (invocation.env?.VETTA_LOOPBACK_TRACE ?? options.baseEnv.VETTA_LOOPBACK_TRACE) === "1";
			const trace = (phase: string): void => {
				if (traceEnabled) console.error(`[loopback ${runId}] ${phase} ${Date.now() - startedAt}ms`);
			};
			return new Promise((resolve, reject) => {
				let child: ChildProcessWithoutNullStreams | undefined;
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let settled = false;
				let stopped = false;
				let timedOut = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let finishClosing: ((error?: Error) => void) | undefined;
				let closed: Promise<void> | undefined;
				const result = (exitCode: number | null): SshProcessResult => ({
					exitCode,
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr).toString("utf8"),
					aborted: stopped,
					timedOut,
				});
				const cleanup = (): void => {
					settled = true;
					if (timer !== undefined) clearTimeout(timer);
					invocation.signal?.removeEventListener("abort", onAbort);
				};
				const fail = (error: Error): void => {
					finishClosing?.(error);
					if (settled) return;
					trace(stopped && child ? "kill-error" : "error");
					cleanup();
					reject(error);
				};
				const stop = (timeout: boolean): void => {
					if (settled || stopped) return;
					stopped = true;
					timedOut = timeout;
					trace(timeout ? "timeout" : "abort");
					if (!child) {
						cleanup();
						resolve(result(null));
						return;
					}
					if (closed) closing.add(closed);
					// Never kill from a stale PID after exit, or from a remote pidfile.
					if (child.exitCode !== null || child.signalCode !== null) {
						fail(new Error("Loopback process exited before its pipes closed"));
						return;
					}
					try {
						options.terminateTree(child);
					} catch (error) {
						fail(error instanceof Error ? error : new Error("Loopback tree termination failed"));
					}
				};
				const onAbort = (): void => stop(false);
				trace("queue");
				invocation.signal?.addEventListener("abort", onAbort, { once: true });
				if (invocation.timeoutMs !== undefined) timer = setTimeout(() => stop(true), invocation.timeoutMs);
				timer?.unref?.();
				if (invocation.signal?.aborted) onAbort();
				// SshConnection sends cleanup immediately before aborting its command. Yield
				// one microtask so that abort registers, then wait for real closure or failure.
				// The request's signal and original timeout already apply while it is queued.
				void Promise.resolve()
					.then(() => Promise.all(closing))
					.then(() => {
						if (settled) return;
						trace("start");
						// MSYS exec replaces its native process. A Node parent retains the
						// taskkill /T root until the shell and all inherited pipes close.
						// Ordinary discovery avoids this extra process for every stat/read.
						const needsParent =
							process.platform === "win32" &&
							(invocation.signal !== undefined || invocation.timeoutMs !== undefined);
						child = spawn(
							needsParent ? process.execPath : options.shellBinary,
							needsParent
								? ["-e", WINDOWS_PARENT_WRAPPER, options.shellBinary, options.scriptPath, ...invocation.argv]
								: [options.scriptPath, ...invocation.argv],
							{
								env: { ...options.baseEnv, ...invocation.env },
								stdio: ["pipe", "pipe", "pipe"],
							},
						);
						const gate = new Promise<void>((resolveClosed, rejectClosed) => {
							finishClosing = (error) => (error ? rejectClosed(error) : resolveClosed());
						});
						closed = gate;
						// Both outcomes remove the gate, and rejection is observed even without a waiter.
						void gate.then(
							() => closing.delete(gate),
							() => closing.delete(gate),
						);
						child.stdout.on("data", (chunk: Buffer) => {
							if (invocation.onStdout) invocation.onStdout(chunk);
							else stdout.push(chunk);
						});
						child.stderr.on("data", (chunk: Buffer) => {
							invocation.onStderr?.(chunk);
							stderr.push(chunk);
						});
						child.on("error", fail);
						child.once("close", (exitCode) => {
							trace("close");
							finishClosing?.();
							if (settled) return;
							cleanup();
							resolve(result(exitCode));
						});
						child.stdin.on("error", () => {});
						child.stdin.end(invocation.stdin);
					}, fail)
					.catch(fail);
			});
		},
	};
}

/** Git Bash does not supply sshd's POSIX session boundary. Clean only our live child tree. */
export function terminateWindowsLoopbackTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	// A missing taskkill is a fixture error, not a successful remote stop.
	let reported = false;
	const reportError = (error: Error): void => {
		if (reported) return;
		reported = true;
		child.emit("error", error);
	};
	killer.once("error", reportError);
	killer.once("close", (code) => {
		if (code !== 0 && child.exitCode === null && child.signalCode === null) {
			reportError(new Error(`Loopback taskkill failed with exit code ${code}`));
		}
	});
}
