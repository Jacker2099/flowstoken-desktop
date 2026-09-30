import { type ChildProcess, spawn } from "node:child_process";
import { createNodeSshProcessRunner } from "./node-process-runner.js";
import type { SshProcessRunner } from "./process-runner.js";

/** Test-only remote host boundary: execute the real shell script, not a simulated command parser. */
export function createShellLoopbackRunner(options: {
	readonly shellBinary: string;
	readonly scriptPath: string;
	readonly baseEnv: NodeJS.ProcessEnv;
	readonly terminateTree: (child: ChildProcess) => void;
}): SshProcessRunner {
	const channelRunner = createNodeSshProcessRunner({ sshBinary: options.shellBinary, baseEnv: options.baseEnv });
	return {
		open(invocation) {
			if (!channelRunner.open) throw new Error("Loopback channel runner unavailable");
			return channelRunner.open({ ...invocation, argv: [options.scriptPath, ...invocation.argv] });
		},
		run(invocation) {
			return new Promise((resolve, reject) => {
				if (invocation.signal?.aborted) {
					resolve({ exitCode: null, stdout: new Uint8Array(), stderr: "", aborted: true });
					return;
				}
				const child = spawn(options.shellBinary, [options.scriptPath, ...invocation.argv], {
					env: { ...options.baseEnv, ...invocation.env },
					stdio: ["pipe", "pipe", "pipe"],
				});
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let settled = false;
				let stopped = false;
				let timedOut = false;
				const stop = (): void => {
					// Never kill from a stale PID after exit/close, or from a remote pidfile.
					if (settled || stopped || child.exitCode !== null || child.signalCode !== null) return;
					stopped = true;
					options.terminateTree(child);
				};
				const timer =
					invocation.timeoutMs === undefined
						? undefined
						: setTimeout(() => {
								timedOut = true;
								stop();
							}, invocation.timeoutMs);
				timer?.unref?.();
				invocation.signal?.addEventListener("abort", stop, { once: true });
				const cleanup = (): void => {
					settled = true;
					if (timer !== undefined) clearTimeout(timer);
					invocation.signal?.removeEventListener("abort", stop);
				};
				child.stdout.on("data", (chunk: Buffer) => {
					if (invocation.onStdout) invocation.onStdout(chunk);
					else stdout.push(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => {
					invocation.onStderr?.(chunk);
					stderr.push(chunk);
				});
				child.once("error", (error) => {
					cleanup();
					reject(error);
				});
				child.once("close", (exitCode) => {
					if (settled) return;
					cleanup();
					resolve({
						exitCode,
						stdout: Buffer.concat(stdout),
						stderr: Buffer.concat(stderr).toString("utf8"),
						aborted: stopped,
						timedOut,
					});
				});
				child.stdin.on("error", () => {});
				child.stdin.end(invocation.stdin);
			});
		},
	};
}

/** Git Bash does not supply sshd's POSIX session boundary. Clean only our live child tree. */
export function terminateWindowsLoopbackTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	// A missing taskkill is a fixture error, not a successful remote stop.
	killer.once("error", (error) => child.emit("error", error));
	killer.once("close", (code) => {
		if (code !== 0 && child.exitCode === null && child.signalCode === null) {
			child.emit("error", new Error(`Loopback taskkill failed with exit code ${code}`));
		}
	});
}
