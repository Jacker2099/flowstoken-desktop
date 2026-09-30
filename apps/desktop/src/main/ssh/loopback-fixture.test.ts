import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createShellLoopbackRunner,
	loopbackRemotePath,
	loopbackShellBinary,
	terminateWindowsLoopbackTree,
} from "@vetta/ssh-transport/testing";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

function fixture() {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "vetta loopback shell ")));
	directories.push(directory);
	const script = join(directory, "fake ssh.sh");
	writeFileSync(script, 'for last; do :; done\nexec /bin/sh -c "$last"\n');
	const stopped: ChildProcess[] = [];
	const runner = createShellLoopbackRunner({
		shellBinary: loopbackShellBinary(),
		scriptPath: loopbackRemotePath(script),
		baseEnv: process.env,
		terminateTree(child) {
			stopped.push(child);
			if (process.platform === "win32") terminateWindowsLoopbackTree(child);
			else child.kill("SIGTERM");
		},
	});
	return { directory, runner, stopped };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loopback remote shell boundary", () => {
	it("passes spaced script paths, quoted arguments and real stdin bytes through a shell", async () => {
		const { runner } = fixture();
		const result = await runner.run({
			argv: ["-T", "ignored-host", "cat; printf '%s' 'literal $HOME ; value'"],
			stdin: Buffer.from("input\n"),
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.from(result.stdout).toString()).toBe("input\nliteral $HOME ; value");
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
