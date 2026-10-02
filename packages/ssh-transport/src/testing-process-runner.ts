import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, dirname } from "node:path";
import { createNodeSshProcessRunner } from "./node-process-runner.js";
import type { SshProcessResult, SshProcessRunner } from "./process-runner.js";
import {
	buildListDirectoryCommand,
	buildRealPathCommand,
	buildStatCommand,
	quoteShellArgument,
} from "./remote-command.js";
import {
	acceptOwnedJobReady,
	stopOwnedJob,
	waitForOwnedJobEmpty,
	waitForOwnedSupervisorLaunch,
} from "./testing-owned-job.js";
import { ReadonlyLoopbackEndpoint } from "./testing-readonly-endpoint.js";
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

function quotedPath(source: string): string | undefined {
	if (!source.startsWith("'")) return undefined;
	let path = "";
	for (let index = 1; index < source.length; index++) {
		if (source[index] !== "'") path += source[index];
		else if (source.slice(index, index + 4) === "'\\''") {
			path += "'";
			index += 3;
		} else return quoteShellArgument(path) === source.slice(0, index + 1) ? path : undefined;
	}
	return undefined;
}

/** Route only exact readonly scripts produced by the transport, never arbitrary commands mentioning stat. */
function isReadonlyFileCommand(command: string): boolean {
	if (command.startsWith("cat -- ")) {
		const path = quotedPath(command.slice("cat -- ".length));
		return path !== undefined && command === `cat -- ${quoteShellArgument(path)}`;
	}
	if (command.startsWith("[ -e ")) {
		const path = quotedPath(command.slice("[ -e ".length));
		if (path === undefined) return false;
		return (
			command === buildRealPathCommand(path) ||
			(["gnu", "bsd"] as const).some((flavor) =>
				[false, true].some((followSymlinks) => command === buildStatCommand(path, flavor, { followSymlinks })),
			)
		);
	}
	if (command.startsWith("cd ")) {
		const path = quotedPath(command.slice("cd ".length));
		return (
			path !== undefined &&
			(["gnu", "bsd"] as const).some((flavor) => command === buildListDirectoryCommand(path, flavor))
		);
	}
	return false;
}

/** Test-only remote host boundary: execute the real shell script, not a simulated command parser. */
export function createShellLoopbackRunner(options: {
	readonly shellBinary: string;
	readonly scriptPath: string;
	readonly baseEnv: NodeJS.ProcessEnv;
	readonly terminateTree: (child: ChildProcess) => void;
	/** Explicit file-fixture opt-in; signals, deadlines, arbitrary commands and channels keep the SSH wrapper. */
	readonly fileShellBinary?: string;
	/** Test-only native POSIX endpoint: interpret sshd's original last argument directly. */
	readonly commandShellBinary?: string;
	readonly fileResultRoot?: { readonly native: string; readonly remote: string };
	/** Owned lifecycle fault injection; never supplied by the real resource fixture. */
	readonly readonlyWorkerScriptForTests?: string;
	readonly verifyReadonlyCloseForTests?: () => Promise<void>;
}): SshProcessRunner & {
	closeReadonlyEndpoint(error?: Error): Promise<void>;
	waitForIdle(): Promise<void>;
	abortOwnedOperations(): void;
} {
	const closing = new Set<Promise<void>>();
	let nextRun = 0;
	const channelRunner = createNodeSshProcessRunner({ sshBinary: options.shellBinary, baseEnv: options.baseEnv });
	let fileEndpoint: ReadonlyLoopbackEndpoint | undefined;
	let fileEndpointClosing: Promise<void> | undefined;
	let fileEndpointFailure: Error | undefined;
	const pendingCalls = new Set<Promise<unknown>>();
	const physicalCloses = new Set<Promise<void>>();
	const aborters = new Set<() => void>();
	const track = <T>(promise: Promise<T>): Promise<T> => {
		pendingCalls.add(promise);
		void promise.then(
			() => pendingCalls.delete(promise),
			() => pendingCalls.delete(promise),
		);
		return promise;
	};
	return {
		abortOwnedOperations() {
			for (const abort of [...aborters]) abort();
		},
		async waitForIdle() {
			while (pendingCalls.size > 0) await Promise.allSettled([...pendingCalls]);
			await Promise.all([...physicalCloses]);
		},
		async closeReadonlyEndpoint(error?: Error) {
			if (fileEndpointClosing) return fileEndpointClosing;
			const endpoint = fileEndpoint;
			if (!endpoint) return;
			fileEndpointClosing = endpoint.close(error);
			try {
				await fileEndpointClosing;
			} catch (error) {
				if (!endpoint.safeToRelease)
					fileEndpointFailure = error instanceof Error ? error : new Error("Readonly endpoint cleanup failed");
				throw error;
			} finally {
				if (endpoint.safeToRelease) {
					fileEndpoint = undefined;
					fileEndpointClosing = undefined;
					fileEndpointFailure = undefined;
				}
			}
		},
		open(invocation) {
			if (!channelRunner.open) throw new Error("Loopback channel runner unavailable");
			const channel = channelRunner.open({ ...invocation, argv: [options.scriptPath, ...invocation.argv] });
			track(channel.exited);
			return channel;
		},
		run(invocation) {
			const runId = ++nextRun;
			const startedAt = Date.now();
			const traceEnabled = (invocation.env?.VETTA_LOOPBACK_TRACE ?? options.baseEnv.VETTA_LOOPBACK_TRACE) === "1";
			const command = String(invocation.argv.at(-1) ?? "");
			const commandHash = createHash("sha256").update(command).digest("hex").slice(0, 16);
			const readonlyFiles =
				options.fileShellBinary !== undefined &&
				invocation.signal === undefined &&
				invocation.timeoutMs === undefined &&
				invocation.stdin === undefined &&
				invocation.onStdout === undefined &&
				invocation.onStderr === undefined &&
				isReadonlyFileCommand(command) &&
				Object.keys(invocation.env ?? {}).every(
					(key) =>
						/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
						!/^(?:path|home|tmpdir|shell|pwd|msystem|msys|bash_env|env)$/i.test(key),
				);
			let requestEndpoint: ReadonlyLoopbackEndpoint | undefined;
			if (readonlyFiles && options.fileResultRoot) {
				if (fileEndpointClosing)
					return Promise.reject(fileEndpointFailure ?? new Error("Readonly loopback endpoint is closing"));
				const persistentEnv: NodeJS.ProcessEnv = { ...options.baseEnv };
				if (process.platform === "win32") {
					const keys = Object.keys(persistentEnv).filter((key) => key.toLowerCase() === "path");
					const key = keys[0] ?? "PATH";
					const value = persistentEnv[key] ?? "";
					for (const other of keys) if (other !== key) delete persistentEnv[other];
					persistentEnv[key] = dirname(options.fileShellBinary!) + delimiter + value;
				}
				fileEndpoint ??= new ReadonlyLoopbackEndpoint({
					shellBinary: options.fileShellBinary!,
					supervisorScript: WINDOWS_PARENT_WRAPPER,
					baseEnv: persistentEnv,
					resultRoot: options.fileResultRoot,
					workerScriptForTests: options.readonlyWorkerScriptForTests,
					verifyCloseForTests: options.verifyReadonlyCloseForTests,
				});
				requestEndpoint = fileEndpoint;
			}

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
			const pendingCall = new Promise<SshProcessResult>((resolve, reject) => {
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
				let finishPhysical: ((error?: Error) => void) | undefined;
				let unsafePhysicalFailure: Error | undefined;
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
					aborters.delete(onAbort);
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
								unsafePhysicalFailure = error;
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
				aborters.add(onAbort);
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
						// MSYS exec can detach native descendants from their original PID tree.
						// Assign the waiting Node supervisor to a private job before Bash starts.
						// Ordinary discovery avoids this extra process for every stat/read.
						const needsParent =
							process.platform === "win32" &&
							(invocation.signal !== undefined ||
								invocation.timeoutMs !== undefined ||
								options.commandShellBinary !== undefined);
						const useJob = needsParent;
						const directFileCommand = readonlyFiles;
						const directCommandEndpoint = options.commandShellBinary !== undefined;
						const endpointBinary = options.commandShellBinary ?? options.shellBinary;
						const endpointArgs = directCommandEndpoint
							? [
									"-c",
									`if [ -n "\${VETTA_LOOPBACK_COMMAND_DIRECTORY:-}" ]; then export PATH="$VETTA_LOOPBACK_COMMAND_DIRECTORY:$PATH"; fi\n${command}`,
								]
							: [options.scriptPath, ...invocation.argv];
						const childEnv: NodeJS.ProcessEnv = {
							...options.baseEnv,
							...invocation.env,
							...(useJob ? { VETTA_LOOPBACK_JOB: "1" } : {}),
						};
						if ((directFileCommand || directCommandEndpoint) && process.platform === "win32") {
							const keys = Object.keys(childEnv).filter((key) => key.toLowerCase() === "path");
							const pathKey =
								Object.keys(invocation.env ?? {}).find((key) => key.toLowerCase() === "path") ??
								keys[0] ??
								"PATH";
							const path = childEnv[pathKey] ?? "";
							for (const key of keys) if (key !== pathKey) delete childEnv[key];
							childEnv[pathKey] =
								`${dirname(directFileCommand ? options.fileShellBinary! : endpointBinary)}${delimiter}${path}`;
						}
						if (requestEndpoint) {
							void requestEndpoint.run(invocation, trace).then((value) => {
								cleanup();
								resolve(value);
							}, fail);
							return;
						}
						if (useJob) ownership = { job: createOwnedWindowsTestJob(), assigned: false, stopped: false };
						const spawned = spawn(
							directFileCommand ? options.fileShellBinary! : needsParent ? process.execPath : endpointBinary,
							directFileCommand
								? [
										"-c",
										`if [ -n "\${VETTA_LOOPBACK_COMMAND_DIRECTORY:-}" ]; then export PATH="$VETTA_LOOPBACK_COMMAND_DIRECTORY:$PATH"; fi\n${command}`,
									]
								: needsParent
									? ["-e", WINDOWS_PARENT_WRAPPER, endpointBinary, ...endpointArgs]
									: endpointArgs,
							{
								env: childEnv,
								stdio:
									needsParent && (traceEnabled || useJob)
										? ["pipe", "pipe", "pipe", "ipc"]
										: ["pipe", "pipe", "pipe"],
							},
						);
						if (!spawned.stdin || !spawned.stdout || !spawned.stderr)
							throw new Error("Loopback pipe contract unavailable");
						child = spawned as ChildProcessWithoutNullStreams;
						const physical = new Promise<void>((resolveClose, rejectClose) => {
							finishPhysical = (error) => {
								if (error) rejectClose(error);
								else {
									physicalCloses.delete(physical);
									resolveClose();
								}
							};
						});
						void physical.catch(() => {});
						physicalCloses.add(physical);
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
						trace("spawn", {
							pid: child.pid,
							needsParent,
							...(directFileCommand ? { directFileCommand: true } : {}),
							...(directCommandEndpoint ? { nativeCommandEndpoint: true } : {}),
							commandKind,
							commandHash,
						});
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
								if (unsafePhysicalFailure) throw unsafePhysicalFailure;
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
								finishPhysical?.();
								finishClosing?.();
								if (settled) return;
								cleanup();
								resolve(result(exitCode));
							})().catch((error: unknown) => {
								const failure = error instanceof Error ? error : new Error("Loopback close barrier failed");
								finishPhysical?.(failure);
								fail(failure);
							});
						});
						child.stdin.on("error", () => {});
						child.stdin.end(invocation.stdin);
					}, fail)
					.catch(fail);
			});
			return track(pendingCall);
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
