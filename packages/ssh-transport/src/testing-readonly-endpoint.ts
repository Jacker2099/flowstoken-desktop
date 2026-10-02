import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import type { SshProcessInvocation, SshProcessResult } from "./process-runner.js";
import { quoteShellArgument } from "./remote-command.js";
import { acceptOwnedJobReady, stopOwnedJob, waitForOwnedJobEmpty } from "./testing-owned-job.js";
import type { NativeWindowsTestJob } from "./testing-windows-job.cjs";
import { createOwnedWindowsTestJob } from "./testing-windows-job.js";

const WORKER_SCRIPT = [
	"directory=$1",
	'printf "ready\\n"',
	"while IFS= read -r request; do",
	'  case "$request" in ""|*[!0-9]*) exit 64;; esac',
	'  ( . "$directory/$request.sh" ) </dev/null >"$directory/$request.out" 2>"$directory/$request.err"',
	"  code=$?",
	'  printf "done %s %s\\n" "$request" "$code"',
	"done",
].join("\n");

interface Ownership {
	job: NativeWindowsTestJob;
	assigned: boolean;
	stopped: boolean;
	closed?: boolean;
}

/** An owned real POSIX endpoint. Only control IDs/status are parsed; all file answers come from the original script. */
export class ReadonlyLoopbackEndpoint {
	private readonly ready: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private readonly exited: Promise<void>;
	private resolveExited!: () => void;
	private rejectExited!: (error: Error) => void;
	private child: ChildProcessWithoutNullStreams | undefined;
	private ownership: Ownership | undefined;
	private directory: string | undefined;
	private failure: Error | undefined;
	private requestedClose = false;
	private closing: Promise<void> | undefined;
	private queue: Promise<void> = Promise.resolve();
	private nextRequest = 0;
	private readonly responses = new Map<number, { resolve: (code: number) => void; reject: (error: Error) => void }>();
	private startupTimer: ReturnType<typeof setTimeout> | undefined;
	private barrierComplete = false;
	private eofSent = false;
	private workerReady = false;

	constructor(
		private readonly options: {
			shellBinary: string;
			supervisorScript: string;
			baseEnv: NodeJS.ProcessEnv;
			resultRoot: { native: string; remote: string };
			workerScriptForTests?: string;
			verifyCloseForTests?: () => Promise<void>;
		},
	) {
		this.ready = new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.exited = new Promise((resolve, reject) => {
			this.resolveExited = resolve;
			this.rejectExited = reject;
		});
		void this.ready.catch(() => {});
		void this.exited.catch(() => {});
	}

	get safeToRelease(): boolean {
		return this.barrierComplete || (this.requestedClose && !this.directory && !this.child);
	}

	run(invocation: SshProcessInvocation, trace: (phase: string, details?: unknown) => void): Promise<SshProcessResult> {
		if (this.requestedClose) return Promise.reject(new Error("Readonly loopback endpoint is closing"));
		const work = this.queue.then(async () => {
			if (this.failure) throw this.failure;
			if (!this.directory) {
				try {
					await this.start(trace);
				} catch (error) {
					this.failure = error instanceof Error ? error : new Error("Readonly endpoint startup failed");
					if (!this.child) {
						try {
							if (this.ownership && !this.ownership.closed) {
								this.ownership.job.close();
								this.ownership.closed = true;
							}
							this.barrierComplete = true;
						} finally {
							this.rejectReady(this.failure);
							this.rejectExited(this.failure);
						}
					}
					throw this.failure;
				}
			}
			await this.ready;
			if (this.failure) throw this.failure;
			const request = ++this.nextRequest;
			const prefix = join(this.directory!, String(request));
			const command = invocation.argv.at(-1) ?? "";
			const script = [
				...Object.entries(invocation.env ?? {}).map(([key, value]) => `export ${key}=${quoteShellArgument(value)}`),
				`if [ -n "\${VETTA_LOOPBACK_COMMAND_DIRECTORY:-}" ]; then export PATH="$VETTA_LOOPBACK_COMMAND_DIRECTORY:$PATH"; fi`,
				command,
			].join("\n");
			await writeFile(`${prefix}.sh`, script);
			const completed = new Promise<number>((resolve, reject) => this.responses.set(request, { resolve, reject }));
			trace("file-request", { request, pid: this.child?.pid });
			this.child!.stdin.write(`${request}\n`, (error) => {
				if (error) this.fail(error);
			});
			let commandCompleted = false;
			try {
				const exitCode = await completed;
				commandCompleted = true;
				if (this.failure) throw this.failure;
				const [stdout, stderr] = await Promise.all([readFile(`${prefix}.out`), readFile(`${prefix}.err`, "utf8")]);
				trace("file-result", { request, exitCode, stdoutBytes: stdout.length });
				return { exitCode, stdout, stderr, aborted: false, timedOut: false };
			} finally {
				this.responses.delete(request);
				if (commandCompleted || this.barrierComplete) {
					await Promise.all(
						["sh", "out", "err"].map((extension) => rm(`${prefix}.${extension}`, { force: true })),
					);
				}
			}
		});
		this.queue = work.then(
			() => {},
			() => {},
		);
		return work;
	}

	close(error?: Error): Promise<void> {
		if (this.closing) return this.closing;
		this.requestedClose = true;
		if (error) this.fail(error);
		this.closing = (async () => {
			await this.queue;
			if (!this.child && this.failure) throw this.failure;
			if (this.child) {
				this.eofSent = true;
				this.child.stdin.end();
				await this.exited;
			}
		})().finally(async () => {
			if (this.directory && this.barrierComplete) await rm(this.directory, { recursive: true, force: true });
		});
		return this.closing;
	}

	private async start(trace: (phase: string, details?: unknown) => void): Promise<void> {
		this.directory = await mkdtemp(join(this.options.resultRoot.native, "readonly-"));
		if (this.failure) throw this.failure;
		const remoteDirectory = posix.join(this.options.resultRoot.remote, basename(this.directory));
		const args = ["-c", this.options.workerScriptForTests ?? WORKER_SCRIPT, "vetta-readonly", remoteDirectory];
		if (process.platform === "win32")
			this.ownership = { job: createOwnedWindowsTestJob(), assigned: false, stopped: false };
		const child = spawn(
			this.ownership ? process.execPath : this.options.shellBinary,
			this.ownership ? ["-e", this.options.supervisorScript, this.options.shellBinary, ...args] : args,
			{
				env: { ...this.options.baseEnv, ...(this.ownership ? { VETTA_LOOPBACK_JOB: "1" } : {}) },
				stdio: this.ownership ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			},
		) as ChildProcessWithoutNullStreams;
		this.child = child;
		trace("file-worker-spawn", { pid: child.pid });
		this.startupTimer = setTimeout(() => this.fail(new Error("Readonly loopback shell did not become ready")), 5000);
		this.startupTimer.unref?.();
		let control = "";
		let stderr = "";
		child.stderr.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString("utf8")).slice(-16_384);
		});
		child.stdout.on("data", (data: Buffer) => {
			if (this.failure) return;
			control += data.toString("utf8");
			let newline = control.indexOf("\n");
			while (newline !== -1) {
				const line = control.slice(0, newline).replace(/\r$/, "");
				control = control.slice(newline + 1);
				if (line === "ready") {
					if (this.workerReady) {
						this.fail(new Error("Readonly endpoint reported ready twice"));
						return;
					}
					this.workerReady = true;
					if (this.startupTimer) clearTimeout(this.startupTimer);
					trace("file-worker-ready", { pid: child.pid });
					this.resolveReady();
				} else {
					const match = line.match(/^done (\d+) (\d+)$/);
					const response = match ? this.responses.get(Number(match[1])) : undefined;
					const code = match ? Number(match[2]) : NaN;
					if (!response || !Number.isSafeInteger(code) || code < 0 || code > 255) {
						this.fail(new Error("Readonly loopback control response is invalid"));
						return;
					}
					response.resolve(code);
				}
				newline = control.indexOf("\n");
			}
		});
		child.on("message", (message: unknown) => {
			if (
				!this.ownership ||
				!message ||
				typeof message !== "object" ||
				!("type" in message) ||
				message.type !== "owned-supervisor-ready"
			)
				return;
			try {
				acceptOwnedJobReady(this.ownership, this.peer(child), message);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error("Readonly endpoint assignment failed"));
			}
		});
		child.on("error", (error) => this.fail(error));
		child.stdin.on("error", (error) => this.fail(error));
		child.once("close", (code) => {
			void (async () => {
				if (this.startupTimer) clearTimeout(this.startupTimer);
				if (!this.eofSent || !this.workerReady || this.responses.size !== 0 || code !== 0)
					this.failure ??= new Error(`Readonly loopback shell exited (${code}): ${stderr}`);
				try {
					if (this.ownership && !this.ownership.closed) {
						this.ownership.job.terminate();
						await waitForOwnedJobEmpty(this.ownership.job);
						trace("file-worker-job-empty", { activeProcesses: 0 });
					}
					if (!this.ownership || !this.ownership.closed) {
						await this.options.verifyCloseForTests?.();
						this.barrierComplete = true;
					}
				} catch (error) {
					this.failure ??= error instanceof Error ? error : new Error("Readonly endpoint cleanup failed");
				} finally {
					if (this.ownership && !this.ownership.closed) {
						this.ownership.job.close();
						this.ownership.closed = true;
					}
				}
				trace("file-worker-close", { exitCode: code });
				if (this.failure) {
					this.rejectReady(this.failure);
					for (const response of this.responses.values()) response.reject(this.failure);
					this.rejectExited(this.failure);
				} else this.resolveExited();
			})().catch((error: unknown) => {
				const failure = error instanceof Error ? error : new Error("Readonly endpoint close failed");
				this.rejectReady(failure);
				this.rejectExited(failure);
				for (const response of this.responses.values()) response.reject(failure);
			});
		});
	}

	private peer(child: ChildProcess) {
		return {
			pid: child.pid,
			alive: () => child.exitCode === null && child.signalCode === null,
			killOwned: () => {
				child.kill();
			},
			launch: () => {
				child.send({ type: "start-owned-shell" }, (error) => {
					if (error) this.fail(error);
				});
			},
		};
	}

	private fail(error: Error): void {
		this.failure ??= error;
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		try {
			if (this.ownership) stopOwnedJob(this.ownership, this.peer(child));
			else if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {
			if (this.ownership && !this.ownership.closed) {
				this.ownership.job.close();
				this.ownership.closed = true;
			} else child.kill();
		}
	}
}
