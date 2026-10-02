// Native POSIX endpoint contract; Windows native PIDs must never be sent to an MSYS kill.
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	buildProcessInfoCommand,
	buildTerminateProcessCommand,
	PROCESS_STILL_ALIVE_EXIT_CODE,
	parseProcessInfo,
} from "./remote-listeners.js";
import { assertNativePosixTestHost } from "./testing-platform.js";

assertNativePosixTestHost();

describe("native POSIX process information", () => {
	it("命令在本机的 ps 上跑得通", () => {
		const result = spawnSync("/bin/sh", ["-c", buildProcessInfoCommand([process.pid])], { encoding: "utf8" });
		const info = parseProcessInfo(result.stdout, Date.now());
		expect(info.get(process.pid)?.command).toBeTruthy();
		expect(info.get(process.pid)?.startedAt).toBeLessThanOrEqual(Date.now());
	});
});

describe("终止进程", () => {
	it("发完 SIGTERM 等到进程真的退出才返回 0", async () => {
		const child = spawn("sleep", ["30"], { stdio: "ignore" });
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		const pid = child.pid ?? 0;
		try {
			const result = spawnSync("/bin/sh", ["-c", buildTerminateProcessCommand(pid, false)], { encoding: "utf8" });
			expect(result.status).toBe(0);
			await closed;
			expect(child.signalCode).toBe("SIGTERM");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
		}
	});

	it("不理 SIGTERM 的进程报「还活着」，SIGKILL 才收得掉", async () => {
		const child = spawn("/bin/sh", ["-c", "trap '' TERM; printf ready; while :; do sleep 0.05; done"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		const pid = child.pid ?? 0;
		try {
			// Signal only after the real shell confirms its TERM trap is installed.
			await new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.stdout?.once("data", () => resolve());
			});
			const term = spawnSync("/bin/sh", ["-c", buildTerminateProcessCommand(pid, false)], { encoding: "utf8" });
			expect(term.status).toBe(PROCESS_STILL_ALIVE_EXIT_CODE);
			const kill = spawnSync("/bin/sh", ["-c", buildTerminateProcessCommand(pid, true)], { encoding: "utf8" });
			expect(kill.status).toBe(0);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
		}
	});

	it("进程不存在时 kill 自己报错，退出码非零且不是「还活着」", () => {
		const result = spawnSync("/bin/sh", ["-c", buildTerminateProcessCommand(999_999, false)], { encoding: "utf8" });
		expect(result.status).not.toBe(0);
		expect(result.status).not.toBe(PROCESS_STILL_ALIVE_EXIT_CODE);
	});
});
