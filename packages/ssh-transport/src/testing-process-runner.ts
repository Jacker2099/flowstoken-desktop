import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createNodeSshProcessRunner } from "./node-process-runner.js";
import type { SshProcessResult, SshProcessRunner } from "./process-runner.js";
import {
	acceptOwnedJobReady,
	stopOwnedJob,
	waitForOwnedJobEmpty,
	waitForOwnedSupervisorLaunch,
} from "./testing-owned-job.js";
import type { NativeWindowsTestJob } from "./testing-windows-job.cjs";
import { createOwnedWindowsTestJob } from "./testing-windows-job.js";
import type { NativeWindowsProcessWitness } from "./testing-windows-witness.cjs";
import { openOwnedWindowsProcessWitness, windowsWitnessModulePath } from "./testing-windows-witness.js";

interface JobOwnership {
	job: NativeWindowsTestJob;
	assigned: boolean;
	stopped: boolean;
	closed?: boolean;
}
const windowsJobs = new WeakMap<ChildProcess, JobOwnership>();

const WINDOWS_PARENT_WRAPPER = [
	'const { spawn } = require("node:child_process");',
	"const __name = (value) => value;",
	`const native = process.env.VETTA_LOOPBACK_TRACE === "1" ? require(${JSON.stringify(windowsWitnessModulePath)}) : null;`,
	"const send = (data) => { try { if (process.send && process.connected) process.send(data, () => {}); } catch {} };",
	"const report = (phase, witness) => { if (!native) return; try { send({ phase, ...(witness ? witness.read() : {}) }); } catch (error) { send({ phase, error: String(error) }); } };",
	"const close = (witness) => { try { witness?.close(); } catch (error) { send({phase: 'witness-close-error', error: String(error)}); } };",
	'let self; try { self = native?.openNativeWindowsProcessWitness(process.pid); report("wrapper-start", self); } catch (error) { send({phase: "wrapper-witness-error", error: String(error)}); }',
	'const launch = () => { const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"] });',
	'let inner; try { if (native && child.pid) inner = native.openNativeWindowsProcessWitness(child.pid); report("shell-start", inner); } catch (error) { send({phase: "shell-witness-error", error: String(error)}); }',
	'child.on("exit", (code, signal) => { report("shell-exit", inner); });',
	"process.stdin.pipe(child.stdin);",
	"child.stdout.pipe(process.stdout);",
	"child.stderr.pipe(process.stderr);",
	'child.stdin.on("error", () => {});',
	'child.on("error", () => { process.stderr.write("Loopback shell failed to start\\n"); process.exitCode = 1; });',
	'child.on("close", (code) => { report("shell-close", inner); close(inner); close(self); process.exitCode = code ?? 1; if (process.connected) { try { process.disconnect(); } catch {} } });',
	"};",
	'if (process.env.VETTA_LOOPBACK_JOB === "1") { const identity = require(' +
		JSON.stringify(windowsWitnessModulePath) +
		").openNativeWindowsProcessWitness(process.pid); const birth = identity.read(); identity.close(); (" +
		waitForOwnedSupervisorLaunch.toString() +
		')(process, launch, () => process.exit(1)); send({type: "owned-supervisor-ready", pid: birth.pid, creationTicks: birth.creationTicks}); } else launch();',
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
			const command = String(invocation.argv.at(-1) ?? "");
			const commandHash = createHash("sha256").update(command).digest("hex").slice(0, 16);
			const commandKind = /\bstat\b/.test(command)
				? "stat"
				: /\bcat\b|\bhead\b/.test(command)
					? "read"
					: /\bfind\b|\bls\b/.test(command)
						? "list"
						: /\breadlink\b/.test(command)
							? "realpath"
							: /\bkill\b/.test(command)
								? "kill"
								: /\buname\b/.test(command)
									? "platform"
									: "execute";
			const trace = (phase: string, details?: unknown): void => {
				if (traceEnabled)
					console.error(
						`[loopback ${runId}] ${phase} ${Date.now() - startedAt}ms ${JSON.stringify(details ?? {})}`,
					);
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
				let witness: NativeWindowsProcessWitness | undefined;
				let ownership: JobOwnership | undefined;
				let firstStdout = true;
				let firstStderr = true;
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
					if (ownership) ownership.stopped = true;
					if (ownership && child && child.exitCode === null && child.signalCode === null) {
						try {
							if (ownership.assigned) ownership.job.terminate();
							else child.kill();
						} catch (cleanupError) {
							trace("job-cleanup-error", { error: String(cleanupError) });
							try {
								ownership.job.close();
								ownership.closed = true;
							} catch (closeError) {
								trace("job-close-error", { error: String(closeError) });
							}
						}
					} else if (ownership && !child) {
						try {
							ownership.job.close();
							ownership.closed = true;
						} catch (closeError) {
							trace("job-close-error", { error: String(closeError) });
						}
					}
					finishClosing?.(error);
					if (settled) return;
					trace(stopped && child ? "kill-error" : "error");
					cleanup();
					reject(error);
				};
				const stop = (timeout: boolean): void => {
					if (settled || stopped) return;
					stopped = true;
					if (ownership) ownership.stopped = true;
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
				trace("queue", { commandKind, commandHash });
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
						const useJob =
							needsParent && (invocation.env?.VETTA_LOOPBACK_JOB ?? options.baseEnv.VETTA_LOOPBACK_JOB) === "1";
						if (useJob) ownership = { job: createOwnedWindowsTestJob(), assigned: false, stopped: false };
						const spawned = spawn(
							needsParent ? process.execPath : options.shellBinary,
							needsParent
								? ["-e", WINDOWS_PARENT_WRAPPER, options.shellBinary, options.scriptPath, ...invocation.argv]
								: [options.scriptPath, ...invocation.argv],
							{
								env: { ...options.baseEnv, ...invocation.env },
								stdio:
									needsParent && (traceEnabled || useJob)
										? ["pipe", "pipe", "pipe", "ipc"]
										: ["pipe", "pipe", "pipe"],
							},
						);
						if (!spawned.stdin || !spawned.stdout || !spawned.stderr)
							throw new Error("Loopback pipe contract unavailable");
						child = spawned as ChildProcessWithoutNullStreams;
						if (ownership) {
							windowsJobs.set(child, ownership);
							child.on("message", (message: unknown) => {
								if (
									!message ||
									typeof message !== "object" ||
									!("type" in message) ||
									message.type !== "owned-supervisor-ready"
								)
									return;
								try {
									if (!ownership || !child || stopped || settled) return;
									const peer = {
										pid: child.pid,
										alive: () => child?.exitCode === null && child?.signalCode === null,
										killOwned: () => {
											child?.kill();
										},
										launch: () => {
											child?.send({ type: "start-owned-shell" }, (error) => {
												if (error) fail(error);
											});
										},
									};
									if (acceptOwnedJobReady(ownership, peer, message))
										trace("job-assigned", {
											pid: child.pid,
											activeProcesses: ownership.job.activeProcesses(),
										});
								} catch (error) {
									fail(error instanceof Error ? error : new Error("Owned supervisor assignment failed"));
								}
							});
						}
						trace("spawn", { pid: child.pid, needsParent, commandKind, commandHash });
						if (needsParent && traceEnabled && child.pid) {
							try {
								witness = openOwnedWindowsProcessWitness(child.pid);
								trace("native-start", witness.read());
							} catch (error) {
								trace("native-witness-error", { error: String(error) });
							}
							child.on("message", (details) => trace("inner-native", details));
						}
						child.on("exit", (code, signal) => {
							trace("exit", { code, signal });
							try {
								if (witness) trace("native-exit", witness.read());
							} catch (error) {
								trace("native-witness-error", { error: String(error) });
							}
							if (ownership && !ownership.closed) {
								try {
									witness?.close();
									witness = undefined;
									ownership.job.terminate();
								} catch (error) {
									fail(error instanceof Error ? error : new Error("Owned job exit cleanup failed"));
								}
							}
						});
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
							if (firstStdout) {
								firstStdout = false;
								trace("stdout-first", { bytes: chunk.length });
							}
							if (invocation.onStdout) invocation.onStdout(chunk);
							else stdout.push(chunk);
						});
						child.stderr.on("data", (chunk: Buffer) => {
							if (firstStderr) {
								firstStderr = false;
								trace("stderr-first", { bytes: chunk.length });
							}
							invocation.onStderr?.(chunk);
							stderr.push(chunk);
						});
						child.on("error", fail);
						child.once("close", (exitCode) => {
							void (async () => {
								trace("close", {
									exitCode,
									stdoutBytes: stdout.reduce((size, chunk) => size + chunk.length, 0),
								});
								try {
									if (witness) trace("native-close", witness.read());
								} catch (error) {
									trace("native-witness-error", { error: String(error) });
								}
								try {
									witness?.close();
								} catch (error) {
									trace("native-witness-close-error", { error: String(error) });
								}
								if (ownership && !ownership.closed) {
									try {
										await waitForOwnedJobEmpty(ownership.job);
										trace("job-empty", { activeProcesses: 0 });
									} finally {
										ownership.job.close();
										if (child) windowsJobs.delete(child);
									}
								}
								if (child) windowsJobs.delete(child);
								finishClosing?.();
								if (settled) return;
								cleanup();
								resolve(result(exitCode));
							})().catch(fail);
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
	const owned = windowsJobs.get(child);
	if (owned) {
		stopOwnedJob(owned, {
			pid: child.pid,
			alive: () => child.exitCode === null && child.signalCode === null,
			killOwned: () => {
				child.kill();
			},
			launch: () => {
				throw new Error("Stop never launches a child");
			},
		});
		return;
	}
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
