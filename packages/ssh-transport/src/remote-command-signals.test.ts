import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { buildKillCommand } from "./remote-command.js";

const execute = promisify(execFile);
// The production remote endpoint is /bin/sh. This override tests that endpoint's dash/Bash implementations.
const shell = process.env.VETTA_TEST_REMOTE_SHELL ?? "/bin/sh";
if (!["/bin/sh", "/bin/dash", "/bin/bash"].includes(shell)) throw new Error("Unsupported test shell");
const token = "vetta-exec-owned-signal-test";

function scriptArgument(): string {
	const command = buildKillCommand(token);
	expect(command.startsWith("/bin/sh -c ")).toBe(true);
	return command.slice("/bin/sh -c ".length);
}

describe(`remote process signals through ${shell}`, () => {
	for (const kind of ["p", "g"] as const) {
		for (const ignoreTerm of [false, true]) {
			it(`${kind === "p" ? "PID" : "isolated process group"} ${ignoreTerm ? "receives KILL after ignoring TERM" : "exits cleanly on TERM"}`, async () => {
				const directory = await mkdtemp(join(tmpdir(), "vetta-signal-test-"));
				const source = `
process.on("SIGTERM", () => {
  process.send({ type: "term" }, () => { if (!${ignoreTerm}) process.exit(0); });
});
setInterval(() => {}, 1000);
process.send({ type: "ready" });
`;
				const child = spawn(process.execPath, ["-e", source], {
					detached: true,
					stdio: ["ignore", "ignore", "ignore", "ipc"],
				});
				const exited = once(child, "exit");
				let termReceived = false;
				let ended = false;
				child.on("message", (message: unknown) => {
					if (message && typeof message === "object" && "type" in message && message.type === "term")
						termReceived = true;
				});
				child.once("exit", () => {
					ended = true;
				});
				try {
					await once(child, "message");
					const pid = child.pid;
					if (pid === undefined || pid <= 1) throw new Error("Test process has no safe PID");
					const pgid = Number((await execute("ps", ["-o", "pgid=", "-p", String(pid)])).stdout.trim());
					// No negative signal is sent unless the newly spawned process owns this isolated group.
					expect(pgid).toBe(pid);
					await writeFile(join(directory, token), `${kind}${pid}`);
					await execute(shell, ["-c", `${shell} -c ${scriptArgument()}`], {
						env: { ...process.env, TMPDIR: directory },
						timeout: 4000,
					});
					await vi.waitFor(
						() => {
							expect(termReceived).toBe(true);
							expect(ended).toBe(true);
						},
						{ timeout: 500 },
					);
					expect(child.exitCode).toBe(ignoreTerm ? null : 0);
					expect(child.signalCode).toBe(ignoreTerm ? "SIGKILL" : null);
					await expect(readFile(join(directory, token))).rejects.toMatchObject({ code: "ENOENT" });
				} finally {
					// ChildProcess.kill addresses only the handle created above, never an arbitrary/stale PID.
					if (!ended) child.kill("SIGKILL");
					await exited;
					await rm(directory, { recursive: true, force: true });
				}
			});
		}
	}

	it("invalid markers send no signals, while an already-exited valid target remains a successful no-op", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vetta-signal-guard-"));
		const marker = join(directory, token);
		const log = join(directory, "signals");
		// Decode the generated script into $1, then evaluate it in THIS shell after installing the recorders.
		// PATH overrides or functions in an outer shell would not intercept the kill builtin safely.
		const script = `set -- ${scriptArgument()}
kill() { printf 'kill:%s\\n' "$*" >> "$SIGNAL_LOG"; return 1; }
pkill() { printf 'pkill:%s\\n' "$*" >> "$SIGNAL_LOG"; return 1; }
eval "$1"`;
		const run = async () =>
			execute(shell, ["-c", script], { env: { ...process.env, TMPDIR: directory, SIGNAL_LOG: log } });
		try {
			// This valid fake PGID must hit the same-shell recorder before any dangerous marker is tested.
			await writeFile(marker, "g424242");
			await run();
			expect(await readFile(log, "utf8")).toMatch(/^kill:[^\n]* -424242\n$/);
			await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
			for (const value of [
				"",
				"g",
				"g0",
				"g1",
				"p1",
				"g0001",
				"p0001",
				"g0002",
				"g2147483648",
				"p999999999999999999999999",
				"x424242",
				"g-424242",
				"g424242; false",
			]) {
				await writeFile(log, "");
				await writeFile(marker, value);
				await run();
				expect(await readFile(log, "utf8"), value).toBe("");
			}
			await run(); // The previous invocation removed the marker: already-gone remains successful.
			expect(await readFile(log, "utf8")).toBe("");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
