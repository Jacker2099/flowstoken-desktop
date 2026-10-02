import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoopbackSshConnection,
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

const directories: string[] = [];

function createRemoteProject(): { dir: string; uri: string } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetta-remote-spawn-")));
	directories.push(dir);
	return { dir, uri: `ssh://build-01${loopbackRemotePath(dir)}` };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("插件的长驻进程与远程项目", () => {
	it("npm install 这类长跑命令在项目所在的机器上执行——本机跑它看不到任何项目文件", async () => {
		// 回归：守卫原先拒绝一切带远程 cwd 的 spawn，设计稿的依赖因此装不上。
		const project = createRemoteProject();
		writeFileSync(join(project.dir, "package.json"), '{"name":"demo"}');

		const started = await spawnPluginCommand("demo", "sh", ["-c", "cat package.json; echo done"], {
			cwd: project.uri,
		});

		await vi.waitFor(
			() => {
				const status = getPluginCommandSpawnStatus("demo", started.spawnId);
				expect(status.running).toBe(false);
				expect(status.exit?.exitCode).toBe(0);
				// 输出来自远端那份 package.json，证明命令确实在项目所在的机器上跑过。
				expect(status.recentOutput).toContain('"name":"demo"');
				expect(status.recentOutput).toContain("done");
			},
			{ timeout: 15_000 },
		);
	});

	it("要端口的进程：端口在远端分配，再转发回本机——插件拿到的始终是本机可连的那个", async () => {
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

		const started = await spawnPluginCommand("demo", "sh", ["-c", "echo port=$MY_PORT; sleep 30"], {
			cwd: project.uri,
			allocatePort: true,
			env: { MY_PORT: "{{PORT}}" },
		});

		expect(started.port).toBeGreaterThan(0);
		expect(forwards).toHaveLength(1);
		expect(forwards[0].localPort).toBe(started.port);
		// 进程拿到的是远端那个端口，与插件看到的本机端口不是同一个。
		expect(forwards[0].remotePort).not.toBe(started.port);
		await vi.waitFor(
			() =>
				expect(getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput).toContain(
					`port=${forwards[0].remotePort}`,
				),
			{ timeout: 15_000 },
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
		const next = await spawnPluginCommand("demo", "sh", ["-c", "echo next=$MY_PORT; sleep 30"], {
			cwd: project.uri,
			allocatePort: true,
			env: { MY_PORT: "{{PORT}}" },
		});
		await vi.waitFor(() => {
			expect(getPluginCommandSpawnStatus("demo", next.spawnId).recentOutput).toContain(
				`next=${forwards[1].remotePort}`,
			);
		});
		await stopPluginCommandSpawn("demo", next.spawnId);
		expect(cancelled).toEqual(forwards);
	});

	it("停止远端进程后状态转为已结束", async () => {
		const project = createRemoteProject();
		const started = await spawnPluginCommand("demo", "sh", ["-c", "echo up; sleep 60"], { cwd: project.uri });
		await vi.waitFor(
			() => expect(getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput).toContain("up"),
			{ timeout: 15_000 },
		);

		await stopPluginCommandSpawn("demo", started.spawnId);

		expect(getPluginCommandSpawnStatus("demo", started.spawnId).running).toBe(false);
	});

	it("停止多层 shell 下的远端进程树后，子进程消失且同一连接可以再次执行", async () => {
		const project = createRemoteProject();
		const source = [
			'const { spawn } = require("node:child_process");',
			`const child = spawn(process.execPath, ["-e", ${JSON.stringify('process.send("ready"); setInterval(() => {}, 1000);')}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });`,
			'child.once("message", () => process.stdout.write("owned-tree=" + process.pid + "," + child.pid + "\\n"));',
			'process.on("SIGTERM", () => child.kill("SIGTERM"));',
			'child.once("exit", () => process.exit());',
		].join("\n");
		writeFileSync(join(project.dir, "owned-process-tree.cjs"), source);
		const started = await spawnPluginCommand("demo", "sh", ["-c", "sh -c 'node owned-process-tree.cjs'"], {
			cwd: project.uri,
		});
		let nativePids: number[] = [];
		await vi.waitFor(() => {
			const output = getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput;
			const match = /owned-tree=(\d+),(\d+)\n/.exec(output);
			expect(match).not.toBeNull();
			nativePids = [Number(match?.[1]), Number(match?.[2])];
			expect(nativePids.every((pid) => pid > 1)).toBe(true);
		});

		const witnesses: ReturnType<typeof openOwnedWindowsProcessWitness>[] = [];
		const report = (phase: string): void => {
			for (const witness of witnesses) {
				try {
					console.error(`[owned-tree] ${phase} ${JSON.stringify(witness.read())}`);
				} catch (error) {
					console.error(`[owned-tree] ${phase}-witness-error ${JSON.stringify({ error: String(error) })}`);
				}
			}
		};
		try {
			if (process.platform === "win32" && process.env.VETTA_LOOPBACK_TRACE === "1") {
				for (const pid of nativePids) {
					try {
						witnesses.push(openOwnedWindowsProcessWitness(pid));
					} catch (error) {
						console.error(`[owned-tree] acquire-error ${JSON.stringify({ pid, error: String(error) })}`);
					}
				}
			}
			report("before-stop");
			const stopping = stopPluginCommandSpawn("demo", started.spawnId);
			void stopping.catch(() => {});
			if (process.env.VETTA_LOOPBACK_JOB === "1" && witnesses.length > 0) {
				try {
					await vi.waitFor(() => {
						for (const witness of witnesses) expect(witness.read().active).toBe(false);
					});
					report("terminated-before-release");
				} finally {
					for (const witness of witnesses.splice(0)) witness.close();
				}
			}
			await stopping;
			report("after-stop");
			expect(getPluginCommandSpawnStatus("demo", started.spawnId).running).toBe(false);
			await vi.waitFor(() => {
				// Read-only liveness probes address only the two native PIDs reported by our owned tree.
				for (const pid of nativePids) expect(() => process.kill(pid, 0)).toThrow();
			});
		} finally {
			report("final");
			for (const witness of witnesses) {
				try {
					witness.close();
				} catch (error) {
					console.error(`[owned-tree] close-error ${JSON.stringify({ error: String(error) })}`);
				}
			}
		}
		const next = await spawnPluginCommand("demo", "sh", ["-c", "printf reconnected"], { cwd: project.uri });
		await vi.waitFor(() => {
			const status = getPluginCommandSpawnStatus("demo", next.spawnId);
			expect(status).toMatchObject({ running: false, exit: { exitCode: 0 }, recentOutput: "reconnected" });
		});
	});

	it("本地项目照旧，并且报得出真实进程号", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetta-local-spawn-")));
		directories.push(dir);
		const started = await spawnPluginCommand("demo", process.execPath, ["-e", "process.stdout.write('local')"], {
			cwd: dir,
		});

		expect(started.pid).toBeGreaterThan(0);
		await vi.waitFor(
			() => expect(getPluginCommandSpawnStatus("demo", started.spawnId).recentOutput).toContain("local"),
			{ timeout: 15_000 },
		);
	});
});
