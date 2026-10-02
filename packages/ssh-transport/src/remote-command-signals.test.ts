import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { buildKillCommand } from "./remote-command.js";
import { assertNativePosixTestHost } from "./testing-platform.js";

assertNativePosixTestHost();

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

function controllerErrorDetails(error: unknown): Record<string, unknown> {
	if (!error || typeof error !== "object") return { error: String(error) };
	return Object.fromEntries(
		["code", "killed", "signal", "stdout", "stderr"].map((key) => [
			key,
			key in error ? Reflect.get(error, key) : undefined,
		]),
	);
}

interface PollingProbe {
	readonly child: ChildProcess;
	readonly pid: number;
	readonly error: unknown;
	readonly log: string;
	readonly ended: () => boolean;
	readonly termReceived: () => boolean;
}

async function withPollingProbe(
	kind: "p" | "g",
	{ legacy, ignoreTerm, coldStart }: { legacy: boolean; ignoreTerm: boolean; coldStart: boolean },
	assertResult: (probe: PollingProbe) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "vetta-polling-test-"));
	const log = join(directory, "signals");
	const child = spawn(
		process.execPath,
		[
			"-e",
			`process.on("SIGTERM", () => process.send({ type: "term" }, () => { if (!${ignoreTerm}) process.exit(0); }));
setInterval(() => {}, 1000);
process.send({ type: "ready" });`,
		],
		{ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
	);
	const exited = once(child, "exit");
	let ended = false;
	let termReceived = false;
	child.once("exit", () => {
		ended = true;
	});
	child.on("message", (message: unknown) => {
		if (message && typeof message === "object" && "type" in message && message.type === "term") termReceived = true;
	});
	try {
		await once(child, "message");
		const pid = child.pid;
		if (pid === undefined || pid <= 1) throw new Error("Test process has no safe PID");
		const pgid = Number((await execute("ps", ["-o", "pgid=", "-p", String(pid)])).stdout.trim());
		expect(pgid).toBe(pid);
		await writeFile(join(directory, token), `${kind}${pid}`);
		const current = scriptArgument();
		const argument = legacy
			? current.replace("[ $i -lt 10 ]", "[ $i -lt 20 ]").replace("do sleep 0.2;", "do sleep 0.1;")
			: current;
		if (legacy) expect(argument).not.toBe(current);
		// Model startup cost in the same real sleep, avoiding a second external launch per poll.
		// Record requested grace separately; the controller's four-second deadline is unchanged.
		const script = `set -- ${argument}
kill() { printf 'kill:%s\\n' "$*" >> "$SIGNAL_LOG"; command kill "$@"; }
pkill() { printf 'pkill:%s\\n' "$*" >> "$SIGNAL_LOG"; command pkill "$@"; }
sleep() {
  printf 'sleep:%s\\n' "$*" >> "$SIGNAL_LOG"
  ${coldStart ? 'case "$1" in 0.1) sleepDelay=0.21;; 0.2) sleepDelay=0.31;; *) return 64;; esac' : 'sleepDelay="$1"'}
  printf 'launch:%s\\n' "$sleepDelay" >> "$SIGNAL_LOG"
  command sleep "$sleepDelay"
  printf 'slept:%s\\n' "$*" >> "$SIGNAL_LOG"
}
eval "$1"`;
		let error: unknown;
		try {
			await execute(shell, ["-c", script], {
				env: { ...process.env, TMPDIR: directory, SIGNAL_LOG: log },
				timeout: 4000,
			});
		} catch (caught) {
			error = caught;
		}
		const recorded = await readFile(log, "utf8");
		if (error)
			console.info("[owned-polling-controller]", {
				...controllerErrorDetails(error),
				pid,
				termReceived,
				ended,
				targetExit: child.exitCode,
				targetSignal: child.signalCode,
			});
		// These observations precede finally; its safety cleanup cannot masquerade as production KILL.
		await assertResult({ child, pid, error, log: recorded, ended: () => ended, termReceived: () => termReceived });
		await expect(readFile(join(directory, token))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		if (!ended) child.kill("SIGKILL");
		await exited;
		await rm(directory, { recursive: true, force: true });
	}
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
					try {
						await execute(shell, ["-c", `${shell} -c ${scriptArgument()}`], {
							env: { ...process.env, TMPDIR: directory },
							timeout: 4000,
						});
					} catch (error) {
						console.error("[owned-signal-controller]", {
							...controllerErrorDetails(error),
							pid,
							termReceived,
							ended,
							targetExit: child.exitCode,
							targetSignal: child.signalCode,
						});
						throw error;
					}
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

	for (const kind of ["p", "g"] as const) {
		it(`${kind} legacy polling times out before KILL when each real sleep has startup cost`, async () => {
			await withPollingProbe(kind, { legacy: true, ignoreTerm: true, coldStart: true }, async (probe) => {
				expect(probe.error).toMatchObject({ killed: true, signal: "SIGTERM", code: null });
				expect(probe.termReceived()).toBe(true);
				expect(probe.ended()).toBe(false);
				expect(probe.child.signalCode).toBeNull();
				expect(() => process.kill(probe.pid, 0)).not.toThrow();
				expect(probe.log).not.toContain("kill:-s KILL");
				expect(probe.log.split("\n").filter((line) => line.startsWith("slept:")).length).toBeLessThan(20);
				const launches = probe.log.split("\n").filter((line) => line.startsWith("launch:"));
				expect(launches.length).toBeGreaterThan(0);
				for (const launch of launches) expect(launch).toBe("launch:0.21");
			});
		});

		it(`${kind} preserves the two-second grace and reaches real KILL within the original deadline despite startup cost`, async () => {
			await withPollingProbe(kind, { legacy: false, ignoreTerm: true, coldStart: true }, async (probe) => {
				expect(probe.error).toBeUndefined();
				await vi.waitFor(() => expect(probe.ended()).toBe(true), { timeout: 500 });
				expect(probe.termReceived()).toBe(true);
				expect(probe.child.signalCode).toBe("SIGKILL");
				expect(probe.log).toContain("kill:-s KILL");
				const delays = probe.log
					.split("\n")
					.filter((line) => line.startsWith("slept:"))
					.map((line) => Number(line.slice("slept:".length)));
				expect(delays).toHaveLength(10);
				expect(delays.reduce((total, delay) => total + delay, 0)).toBeCloseTo(2);
				const launches = probe.log.split("\n").filter((line) => line.startsWith("launch:"));
				expect(launches).toEqual(Array.from({ length: 10 }, () => "launch:0.31"));
			});
		});

		it(`${kind} detects ordinary TERM completion using at most 200ms polling intervals`, async () => {
			await withPollingProbe(kind, { legacy: false, ignoreTerm: false, coldStart: false }, async (probe) => {
				expect(probe.error).toBeUndefined();
				await vi.waitFor(() => expect(probe.ended()).toBe(true), { timeout: 500 });
				expect(probe.termReceived()).toBe(true);
				expect(probe.child.exitCode).toBe(0);
				expect(probe.child.signalCode).toBeNull();
				const delays = probe.log
					.split("\n")
					.filter((line) => line.startsWith("slept:"))
					.map((line) => Number(line.slice("slept:".length)));
				expect(delays.length).toBeLessThan(10);
				for (const delay of delays) expect(delay).toBeLessThanOrEqual(0.2);
			});
		});
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
