import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoopbackSshConnection,
	createLoopbackTestScope,
	loopbackRemotePath,
	openOwnedWindowsProcessWitness,
} from "@vetta/ssh-transport/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const connection = createLoopbackSshConnection("build-01");
vi.mock("../ssh/ssh-runtime.js", () => ({ getSshConnection: () => connection }));
// 端口转发经统一账本建立，而账本变化会广播给窗口：没有窗口的测试里也要有 BrowserWindow。
vi.mock("electron", () => ({
	webContents: { getAllWebContents: () => [] },
	BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../logger.js", () => ({
	getAppLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock("./plugin-catalog.js", () => ({
	listPlugins: () => [
		{
			id: "demo",
			enabled: true,
			permissions: ["agent.command.spawn"],
			grantedPermissions: ["agent.command.spawn"],
			declaredCommands: ["sh", "npm", process.execPath],
			grantedCommandNames: ["sh", "npm", process.execPath],
		},
	],
}));

const { getPluginCommandSpawnStatus, spawnPluginCommand, stopPluginCommandSpawn } = await import(
	"./command-spawner.js"
);
const commandLauncher = await import("./command-launcher.js");
const spawnedProcess = await import("./spawned-process.js");

const directories: string[] = [];
const scopes: ReturnType<typeof createCommandScope>[] = [];
const restoreConnections: (() => Promise<void>)[] = [];

function createCommandScope() {
	const scope = createLoopbackTestScope();
	scope.onClosing(() => connection.abortOwnedOperations());
	const observed = observeProcessEvents(scope);
	return Object.assign(scope, {
		spawn: (...args: Parameters<typeof spawnPluginCommand>) => {
			const index = observed.starts.length;
			return scope
				.start(
					() => spawnPluginCommand(...args),
					(result) => stopPluginCommandSpawn(args[0], result.spawnId),
				)
				.then((result) => {
					observed.bind(result.spawnId, index);
					return result;
				});
		},
		output: observed.output,
		waitFor: (check: () => void, options?: Parameters<typeof vi.waitFor>[1]) =>
			scope.until(check, (predicate) => vi.waitFor(predicate, options)),
	});
}

/** Observe the real process; a returned spawnId is not an output-ready event. */
function observeProcessEvents(scope: ReturnType<typeof createLoopbackTestScope>) {
	const original = spawnedProcess.startProcess;
	const starts: {
		process: ReturnType<typeof original>;
		chunks: Buffer[];
		exit?: { exitCode: number | null; signal: string | null };
		stages: string[];
		checks: Set<() => void>;
	}[] = [];
	const byId = new Map<string, (typeof starts)[number]>();
	const pending = new Set<(error: Error) => void>();
	let closed: Error | undefined;
	const spy = vi.spyOn(spawnedProcess, "startProcess").mockImplementation((...args) => {
		const process = original(...args);
		const entry: (typeof starts)[number] = { process, chunks: [], stages: ["started"], checks: new Set() };
		starts.push(entry);
		process.onOutput((chunk) => {
			entry.chunks.push(chunk);
			entry.stages.push("output");
			for (const check of entry.checks) check();
		});
		process.onExit((exitCode, signal) => {
			entry.exit = { exitCode, signal };
			entry.stages.push("exit");
			// The plugin's record listener follows this observer; read its updated
			// running/exit state after all listeners for this actual event complete.
			for (const check of entry.checks) queueMicrotask(check);
		});
		return process;
	});
	scope.onClosing(() => {
		closed = new Error("Owned process observation closed");
		for (const reject of pending) reject(closed);
	});
	// Restore only after scope stop/physical-close barriers, before removing files.
	restoreConnections.push(async () => spy.mockRestore());
	return {
		starts,
		bind(spawnId: string, index: number) {
			if (starts.length !== index + 1) throw new Error("Expected exactly one real process per plugin spawn");
			byId.set(spawnId, starts[index]);
		},
		output(spawnId: string, expected: string | RegExp, requireExit = false): Promise<void> {
			if (closed) return Promise.reject(closed);
			const entry = byId.get(spawnId);
			if (!entry) return Promise.reject(new Error("Missing observed real process"));
			return scope.track(
				new Promise<void>((resolve, reject) => {
					let settled = false;
					const finish = (error?: Error) => {
						if (settled) return;
						settled = true;
						entry.checks.delete(check);
						pending.delete(fail);
						if (error) reject(error);
						else resolve();
					};
					const fail = (error: Error) => finish(error);
					const check = () => {
						if (settled) return;
						if (closed) return fail(closed);
						const output = Buffer.concat(entry.chunks).toString();
						const matches = typeof expected === "string" ? output.includes(expected) : expected.test(output);
						const ended = entry.process.finished || entry.exit !== undefined;
						if (ended && (!requireExit || !matches || entry.exit?.exitCode !== 0)) {
							fail(
								new Error(
									`Real command exited before expected output/completion: ${JSON.stringify({ status: getPluginCommandSpawnStatus("demo", spawnId), exit: entry.exit, output, stages: entry.stages })}`,
								),
							);
						} else if (matches && (!requireExit || ended)) finish();
					};
					entry.checks.add(check);
					pending.add(fail);
					check();
				}),
			);
		},
	};
}

function ownedIt(name: string, body: (scope: ReturnType<typeof createCommandScope>) => Promise<void>) {
	it(name, () => {
		const scope = createCommandScope();
		scopes.push(scope);
		return scope.track(body(scope));
	});
}

function observeLocalLaunch() {
	const launch = commandLauncher.spawnCrossPlatformCommand;
	let child: ChildProcess | undefined;
	let closed: Promise<number | null> | undefined;
	const observer = vi.spyOn(commandLauncher, "spawnCrossPlatformCommand").mockImplementation((...args) => {
		child = launch(...args);
		closed = new Promise((resolve) => child?.once("close", resolve));
		return child;
	});
	return {
		get child() {
			if (!child) throw new Error("Expected the real local launcher to create an owned child");
			return child;
		},
		get closed() {
			if (!closed) throw new Error("Expected the real local ChildProcess close barrier");
			return closed;
		},
		async cleanup() {
			try {
				if (child?.exitCode === null && child.signalCode === null) child.kill();
				if (closed) await closed;
			} finally {
				observer.mockRestore();
			}
		},
	};
}

function createRemoteProject(): { dir: string; uri: string } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetta-remote-spawn-")));
	directories.push(dir);
	return { dir, uri: `ssh://build-01${loopbackRemotePath(dir)}` };
}

afterEach(async () => {
	const results = await Promise.allSettled(
		scopes.splice(0).map((scope) => scope.close(() => connection.waitForIdle())),
	);
	results.push(...(await Promise.allSettled(restoreConnections.splice(0).map((restore) => restore()))));
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("插件的长驻进程与远程项目", () => {
	ownedIt("npm install 这类长跑命令在项目所在的机器上执行——本机跑它看不到任何项目文件", async (scope) => {
		// 回归：守卫原先拒绝一切带远程 cwd 的 spawn，设计稿的依赖因此装不上。
		const project = createRemoteProject();
		writeFileSync(join(project.dir, "package.json"), '{"name":"demo"}');

		const started = await scope.spawn("demo", "sh", ["-c", "cat package.json; echo done"], {
			cwd: project.uri,
		});

		await scope.output(started.spawnId, "done", true);
		const status = getPluginCommandSpawnStatus("demo", started.spawnId);
		expect(status.running).toBe(false);
		expect(status.exit?.exitCode).toBe(0);
		// 输出来自远端那份 package.json，证明命令确实在项目所在的机器上跑过。
		expect(status.recentOutput).toContain('"name":"demo"');
		expect(status.recentOutput).toContain("done");
	});

	ownedIt("要端口的进程：端口在远端分配，再转发回本机——插件拿到的始终是本机可连的那个", async (scope) => {
		// 界面只能连本机端口，而服务器必须跑在项目所在的机器上。宿主把这两件事接起来，
		// 插件不必知道自己的进程在哪。
		const project = createRemoteProject();
		const forwards: { localPort: number; remotePort: number }[] = [];
		const cancelled: { localPort: number; remotePort: number }[] = [];
		const listeners = new Map<number, Server>();
		let reportCancelStarted = (): void => {};
		const cancelStarted = new Promise<void>((resolve) => {
			reportCancelStarted = resolve;
		});
		let releaseCancel = (): void => {};
		const cancelAllowed = new Promise<void>((resolve) => {
			releaseCancel = resolve;
		});
		scope.onClosing(() => releaseCancel());
		const originalForward = connection.forwardPort;
		const originalCancel = connection.cancelPortForward;
		restoreConnections.push(async () => {
			for (const listener of listeners.values()) {
				if (listener.listening)
					await new Promise<void>((resolve, reject) =>
						listener.close((error) => (error ? reject(error) : resolve())),
					);
			}
			listeners.clear();
			connection.forwardPort = originalForward;
			connection.cancelPortForward = originalCancel;
		});
		connection.forwardPort = async (localPort: number, remotePort: number) => {
			const listener = createServer();
			await new Promise<void>((resolve, reject) => {
				listener.once("error", reject);
				listener.listen(localPort, "127.0.0.1", resolve);
			});
			listeners.set(localPort, listener);
			forwards.push({ localPort, remotePort });
		};
		connection.cancelPortForward = async (localPort: number, remotePort: number) => {
			reportCancelStarted();
			await cancelAllowed;
			const listener = listeners.get(localPort);
			if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
			listeners.delete(localPort);
			cancelled.push({ localPort, remotePort });
		};

		const started = await scope.spawn("demo", "sh", ["-c", "echo port=$MY_PORT; sleep 30"], {
			cwd: project.uri,
			allocatePort: true,
			env: { MY_PORT: "{{PORT}}" },
		});

		expect(started.port).toBeGreaterThan(0);
		expect(forwards).toHaveLength(1);
		expect(forwards[0].localPort).toBe(started.port);
		// 进程拿到的是远端那个端口，与插件看到的本机端口不是同一个。
		expect(forwards[0].remotePort).not.toBe(started.port);
		await scope.output(started.spawnId, `port=${forwards[0].remotePort}`);
		expect(getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput).toContain(
			`port=${forwards[0].remotePort}`,
		);

		let stopFinished = false;
		const stopping = stopPluginCommandSpawn("demo", started.spawnId).then(() => {
			stopFinished = true;
		});
		try {
			await cancelStarted;
			// Finish this event-loop phase: the external cancellation is still explicitly held.
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(stopFinished).toBe(false);
			expect(cancelled).toEqual([]);
		} finally {
			releaseCancel();
			await stopping;
		}
		expect(cancelled).toEqual(forwards);
		const reused = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				reused.once("error", reject);
				reused.listen(started.port, "127.0.0.1", resolve);
			});
		} finally {
			await new Promise<void>((resolve) => reused.close(() => resolve()));
		}
		// The same SSH connection can allocate, forward and stop a new plugin server.
		const next = await scope.spawn("demo", "sh", ["-c", "echo next=$MY_PORT; sleep 30"], {
			cwd: project.uri,
			allocatePort: true,
			env: { MY_PORT: "{{PORT}}" },
		});
		await scope.output(next.spawnId, `next=${forwards[1].remotePort}`);
		expect(getPluginCommandSpawnStatus("demo", next.spawnId).recentOutput).toContain(
			`next=${forwards[1].remotePort}`,
		);
		await stopPluginCommandSpawn("demo", next.spawnId);
		expect(cancelled).toEqual(forwards);
	});

	ownedIt("停止远端进程后状态转为已结束", async (scope) => {
		const project = createRemoteProject();
		const started = await scope.spawn("demo", "sh", ["-c", "echo up; sleep 60"], { cwd: project.uri });
		await scope.output(started.spawnId, "up");
		expect(getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput).toContain("up");

		await stopPluginCommandSpawn("demo", started.spawnId);

		expect(getPluginCommandSpawnStatus("demo", started.spawnId).running).toBe(false);
	});

	ownedIt("停止多层 shell 下的远端进程树后，子进程消失且同一连接可以再次执行", async (scope) => {
		const project = createRemoteProject();
		const source = [
			'const { spawn } = require("node:child_process");',
			`const child = spawn(process.execPath, ["-e", ${JSON.stringify('process.send("ready"); setInterval(() => {}, 1000);')}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });`,
			'child.once("message", () => process.stdout.write("owned-tree=" + process.pid + "," + child.pid + "\\n"));',
			'process.on("SIGTERM", () => child.kill("SIGTERM"));',
			'child.once("exit", () => process.exit());',
		].join("\n");
		writeFileSync(join(project.dir, "owned-process-tree.cjs"), source);
		const started = await scope.spawn("demo", "sh", ["-c", "sh -c 'node owned-process-tree.cjs'"], {
			cwd: project.uri,
		});
		let nativePids: number[] = [];
		await scope.output(started.spawnId, /owned-tree=\d+,\d+\n/);
		const output = getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput;
		const match = /owned-tree=(\d+),(\d+)\n/.exec(output);
		expect(match).not.toBeNull();
		nativePids = [Number(match?.[1]), Number(match?.[2])];
		expect(nativePids.every((pid) => pid > 1)).toBe(true);

		const witnesses: ReturnType<typeof openOwnedWindowsProcessWitness>[] = [];
		const closeWitnesses = (): void => {
			for (const witness of witnesses.splice(0)) {
				try {
					witness.close();
				} catch (error) {
					console.error(`[owned-tree] close-error ${JSON.stringify({ error: String(error) })}`);
				}
			}
		};
		const report = (phase: string): void => {
			if (process.env.VETTA_LOOPBACK_TRACE !== "1") return;
			for (const witness of witnesses) {
				try {
					console.error(`[owned-tree] ${phase} ${JSON.stringify(witness.read())}`);
				} catch (error) {
					console.error(`[owned-tree] ${phase}-witness-error ${JSON.stringify({ error: String(error) })}`);
				}
			}
		};
		try {
			if (process.platform === "win32") {
				for (const pid of nativePids) {
					const witness = openOwnedWindowsProcessWitness(pid);
					witnesses.push(witness);
					expect(witness.read().active).toBe(true);
				}
			}
			report("before-stop");
			const stopping = stopPluginCommandSpawn("demo", started.spawnId);
			void stopping.catch(() => {});
			if (witnesses.length > 0) {
				try {
					await scope.waitFor(() => {
						for (const witness of witnesses) expect(witness.read().active).toBe(false);
					});
					report("terminated-before-release");
				} finally {
					closeWitnesses();
				}
			}
			await stopping;
			report("after-stop");
			expect(getPluginCommandSpawnStatus("demo", started.spawnId).running).toBe(false);
			await scope.waitFor(() => {
				// Read-only liveness probes address only the two native PIDs reported by our owned tree.
				for (const pid of nativePids) expect(() => process.kill(pid, 0)).toThrow();
			});
		} finally {
			report("final");
			closeWitnesses();
		}
		const next = await scope.spawn("demo", "sh", ["-c", "printf reconnected"], { cwd: project.uri });
		await scope.output(next.spawnId, "reconnected", true);
		expect(getPluginCommandSpawnStatus("demo", next.spawnId)).toMatchObject({
			running: false,
			exit: { exitCode: 0 },
			recentOutput: "reconnected",
		});
	});

	ownedIt("本地项目照旧，并且报得出真实进程号", async (scope) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetta-local-spawn-")));
		directories.push(dir);
		const observed = observeLocalLaunch();
		scope.onCleanup(() => observed.cleanup());
		try {
			const started = await scope.spawn("demo", process.execPath, ["-e", "process.stdout.write('local')"], {
				cwd: dir,
			});
			expect(started.pid).toBeGreaterThan(0);
			expect(started.pid).toBe(observed.child.pid);
			expect(await observed.closed).toBe(0);
			expect(getPluginCommandSpawnStatus("demo", started.spawnId)).toMatchObject({
				running: false,
				exit: { exitCode: 0 },
				recentOutput: "local",
			});
			expect(() => process.kill(started.pid, 0)).toThrow();
		} finally {
			await observed.cleanup();
		}
	});

	ownedIt("本地 stdout 已出现仍可能活着：实际 close 后才可清理自己的 cwd", async (scope) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetta-local-close-gate-")));
		directories.push(dir);
		const gate = join(dir, "release-owned-child");
		const program = `process.stdout.write('local');const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(gate)}))clearInterval(timer)},10);`;
		const observed = observeLocalLaunch();
		scope.onCleanup(() => observed.cleanup());
		try {
			const started = await scope.spawn("demo", process.execPath, ["-e", program], { cwd: dir });
			await scope.output(started.spawnId, "local");
			expect(getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput).toContain("local");
			// The old output-only predicate is satisfied while the real process still holds its cwd.
			expect(observed.child.exitCode).toBeNull();
			expect(() => process.kill(started.pid, 0)).not.toThrow();
			writeFileSync(gate, "release");
			expect(await observed.closed).toBe(0);
			expect(() => process.kill(started.pid, 0)).toThrow();
			rmSync(dir, { recursive: true });
		} finally {
			await observed.cleanup();
		}
	});
});

import type { ChildProcess } from "node:child_process";
