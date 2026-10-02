import { describe, expect, it } from "vitest";
import { createNodeSshProcessRunner } from "./node-process-runner.js";

// 当前 Node 顶替 ssh：这一层验证本地子进程与管道，不需要把 Windows 伪装成 POSIX 主机。
const runner = createNodeSshProcessRunner({ sshBinary: process.execPath });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("ssh 子进程执行器", () => {
	it("不流式消费时，完整输出在结果里", async () => {
		const result = await runner.run({
			argv: ["-e", 'process.stdout.write("abc"); process.stderr.write("oops"); process.exit(3)'],
		});
		expect(decode(result.stdout)).toBe("abc");
		expect(result.stderr).toBe("oops");
		expect(result.exitCode).toBe(3);
	});

	it("流式消费时不再另存一份——长驻任务的日志会让内存随运行时间无限增长", async () => {
		const chunks: string[] = [];
		const result = await runner.run({
			argv: ["-e", 'process.stdout.write("abc")'],
			onStdout: (chunk) => chunks.push(decode(chunk)),
		});
		expect(chunks.join("")).toBe("abc");
		expect(result.stdout.byteLength).toBe(0);
	});

	it("流式消费的 stderr 只留尾部，够做错误分类即可", async () => {
		const result = await runner.run({
			argv: ["-e", 'process.stderr.write("0".repeat(40_000) + "TAIL")'],
			onStderr: () => {},
		});
		expect(result.stderr.endsWith("TAIL")).toBe(true);
		expect(result.stderr.length).toBe(16 * 1024);
	});

	it("超时与主动取消分得开", async () => {
		const wait = ["-e", "setInterval(() => {}, 1000)"];
		const timedOut = await runner.run({ argv: wait, timeoutMs: 50 });
		expect(timedOut).toMatchObject({ aborted: true, timedOut: true });

		const controller = new AbortController();
		const pending = runner.run({ argv: wait, signal: controller.signal });
		controller.abort();
		await expect(pending).resolves.toMatchObject({ aborted: true, timedOut: false });
	});

	for (const mode of ["run", "channel"] as const) {
		it.runIf(process.platform !== "win32")(`取消 ${mode} 时终止自有 POSIX 进程组，孙进程不再持有管道`, async () => {
			const controller = new AbortController();
			let reportDescendant = (_pid: number): void => {};
			const descendantStarted = new Promise<number>((resolve) => {
				reportDescendant = resolve;
			});
			const program = [
				'const { spawn } = require("node:child_process");',
				'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
				'process.stdout.write(String(child.pid) + "\\n");',
			].join("\n");
			const onStdout = (chunk: Uint8Array): void => reportDescendant(Number.parseInt(decode(chunk).trim(), 10));
			const channel = mode === "channel" ? runner.open?.({ argv: ["-e", program], onStdout }) : undefined;
			const pending = channel
				? channel.exited
				: runner.run({ argv: ["-e", program], signal: controller.signal, onStdout });
			const pid = await descendantStarted;
			expect(pid).toBeGreaterThan(1);
			let deadline: ReturnType<typeof setTimeout> | undefined;
			try {
				if (channel) channel.kill();
				else controller.abort();
				const result = await Promise.race([
					pending,
					new Promise<never>((_resolve, reject) => {
						deadline = setTimeout(() => reject(new Error("owned SSH descendant retained the pipe")), 1000);
					}),
				]);
				if (!channel) expect(result).toMatchObject({ aborted: true, timedOut: false });
				expect(() => process.kill(pid, 0)).toThrow();
			} finally {
				if (deadline) clearTimeout(deadline);
				// This fresh PID came from the child created by this test; never from user state or a remote marker.
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
				await pending;
			}
		});
	}
});
