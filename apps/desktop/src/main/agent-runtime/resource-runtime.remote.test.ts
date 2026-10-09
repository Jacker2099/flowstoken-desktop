import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, posix } from "node:path";
import type { SessionResourceRuntime } from "@vetta/coding-agent/resources";
import {
	buildListDirectoryCommand,
	buildRealPathCommand,
	buildStatCommand,
	quoteShellArgument,
} from "@vetta/ssh-transport";
import {
	createLoopbackSshConnection,
	createShellLoopbackRunner,
	loopbackRemotePath,
	loopbackShellBinary,
	terminateWindowsLoopbackTree,
} from "@vetta/ssh-transport/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const connection = createLoopbackSshConnection("loopback", { directFileCommands: process.platform === "win32" });
vi.mock("../ssh/ssh-runtime.js", () => ({ getSshConnection: () => connection }));

const { createDesktopPromptRuntimeSources } = await import("./resource-runtime.js");
const directories: string[] = [];
const pendingReloads = new Set<Promise<unknown>>();
const readonlyRunners = new Set<{ closeReadonlyEndpoint(error?: Error): Promise<void> }>();

function trackReload<T>(loading: Promise<T>): Promise<T> {
	pendingReloads.add(loading);
	// Observe both outcomes without creating an unhandled rejecting finally-chain.
	void loading.then(
		() => pendingReloads.delete(loading),
		() => pendingReloads.delete(loading),
	);
	return loading;
}

function temporaryDirectory(parent: string, prefix: string): string {
	const directory = realpathSync(mkdtempSync(join(parent, prefix)));
	directories.push(directory);
	return directory;
}

async function cleanupResources(): Promise<void> {
	// A timed-out test still fails; finish only its owned I/O before deleting its fixture files.
	await Promise.allSettled([...pendingReloads]);
	await connection.closeReadonlyEndpoint();
	await Promise.all([...readonlyRunners].map((runner) => runner.closeReadonlyEndpoint()));
	readonlyRunners.clear();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}
afterEach(cleanupResources);

beforeAll(async () => {
	// Establish the loopback SSH fixture before measuring resource discovery.
	await connection.probePlatform();
});

function watchResourceReads() {
	return {
		stat: vi.spyOn(connection, "stat"),
		readText: vi.spyOn(connection, "readFile"),
		realPath: vi.spyOn(connection, "realPath"),
	};
}

function resourceFixture() {
	const testHome = temporaryDirectory(tmpdir(), "vetta-resource-home-");
	vi.stubEnv("VETTA_HOME", testHome);
	vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", testHome);
	// Remote ancestor discovery must not traverse the developer's Windows profile.
	const fixtureParent = process.platform === "win32" ? parse(tmpdir()).root : tmpdir();
	const remoteRoot = temporaryDirectory(fixtureParent, "vetta-remote-project-");
	const remotePath = loopbackRemotePath(remoteRoot);
	mkdirSync(join(remoteRoot, ".agents/skills/deploy"), { recursive: true });
	writeFileSync(join(remoteRoot, "AGENTS.md"), "REMOTE-PROJECT-RULES\n");
	writeFileSync(
		join(remoteRoot, ".agents/skills/deploy/SKILL.md"),
		"---\nname: deploy\ndescription: Deploy the remote service.\n---\n\nRun the deploy script.\n",
	);
	const agentDir = temporaryDirectory(tmpdir(), "vetta-agent-dir-");
	return { remoteRoot, remotePath, agentDir };
}

describe("readonly loopback endpoint matches the actual SSH wrapper", { timeout: 60_000 }, () => {
	let fixture: ReturnType<typeof readonlyEndpointFixture>;
	beforeEach(() => {
		fixture = readonlyEndpointFixture();
	});
	function readonlyEndpointFixture() {
		const directory = temporaryDirectory(tmpdir(), "loopback readonly quoted ");
		const remoteDirectory = loopbackRemotePath(directory);
		const dataDirectory = join(directory, "data");
		const toolsDirectory = join(directory, "tools");
		mkdirSync(dataDirectory);
		mkdirSync(toolsDirectory);
		mkdirSync(join(directory, "home"));
		const data = Buffer.from([0, 255, 10, 13, 39, 36, 65]);
		writeFileSync(join(dataDirectory, "quoted 'stat' file.txt"), data);
		const marker = join(directory, "wrapped.marker");
		const envMarker = join(directory, "env.marker");
		const remoteMarker = posix.join(remoteDirectory, "wrapped.marker");
		const remoteEnvMarker = posix.join(remoteDirectory, "env.marker");
		const scriptPath = join(directory, "ssh.sh");
		writeFileSync(
			scriptPath,
			[
				"#!/bin/sh",
				"for last; do :; done",
				`printf wrapped >> ${quoteShellArgument(remoteMarker)}`,
				`if [ -n "\${VETTA_LOOPBACK_COMMAND_DIRECTORY:-}" ]; then export PATH="$VETTA_LOOPBACK_COMMAND_DIRECTORY:$PATH"; fi`,
				'exec /bin/sh -c "$last"',
			].join("\n"),
		);
		chmodSync(scriptPath, 0o755);
		const catPath = join(toolsDirectory, "cat");
		writeFileSync(
			catPath,
			[
				"#!/bin/sh",
				`printf '%s|%s|%s' "$HOME" "$SHELL" "$DIFF_ENV" > ${quoteShellArgument(remoteEnvMarker)}`,
				'exec /bin/cat "$@"',
			].join("\n"),
		);
		chmodSync(catPath, 0o755);
		const shellBinary = loopbackShellBinary();
		const fileShellBinary =
			process.platform === "win32" ? join(dirname(dirname(shellBinary)), "usr", "bin", "sh.exe") : "/bin/sh";
		const options = {
			shellBinary,
			scriptPath: posix.join(remoteDirectory, "ssh.sh"),
			baseEnv: {
				...process.env,
				HOME: posix.join(remoteDirectory, "home"),
				TMPDIR: remoteDirectory,
				SHELL: "/bin/sh",
				VETTA_LOOPBACK_COMMAND_DIRECTORY: posix.join(remoteDirectory, "tools"),
			},
			terminateTree: (child: Parameters<typeof terminateWindowsLoopbackTree>[0]) => {
				if (process.platform === "win32") terminateWindowsLoopbackTree(child);
				else child.kill();
			},
		};
		const wrapped = createShellLoopbackRunner(options);
		const direct = createShellLoopbackRunner({
			...options,
			fileShellBinary,
			fileResultRoot: { native: directory, remote: remoteDirectory },
		});
		readonlyRunners.add(wrapped);
		readonlyRunners.add(direct);
		return {
			wrapped,
			direct,
			remoteFile: posix.join(remoteDirectory, "data", "quoted 'stat' file.txt"),
			remoteDataDirectory: posix.join(remoteDirectory, "data"),
			remoteMissing: posix.join(remoteDirectory, "data", "missing.txt"),
			expectedHome: options.baseEnv.HOME,
			data,
			marker,
			envMarker,
			directory,
			remoteDirectory,
			catPath,
			options,
			fileShellBinary,
		};
	}
	it.each(["read", "stat", "list", "realpath"] as const)(
		"executes genuine %s with identical bytes/exit and preserves the owned path and environment",
		(operation) =>
			trackReload(
				(async () => {
					const flavor = process.platform === "darwin" ? "bsd" : "gnu";
					const command =
						operation === "read"
							? `cat -- ${quoteShellArgument(fixture.remoteFile)}`
							: operation === "stat"
								? buildStatCommand(fixture.remoteFile, flavor)
								: operation === "list"
									? buildListDirectoryCommand(fixture.remoteDataDirectory, flavor)
									: buildRealPathCommand(fixture.remoteFile);
					const invocation = { argv: ["ignored-ssh-argument", command], env: { DIFF_ENV: "literal $value" } };
					const direct = await fixture.direct.run(invocation);
					expect(direct.exitCode).toBe(0);
					expect(() => readFileSync(fixture.marker)).toThrow();
					const wrapped = await fixture.wrapped.run(invocation);
					expect(wrapped).toEqual(direct);
					expect(readFileSync(fixture.marker, "utf8")).toBe("wrapped");
					if (operation === "read") {
						expect(Buffer.from(direct.stdout)).toEqual(fixture.data);
						expect(readFileSync(fixture.envMarker, "utf8")).toBe(
							`${fixture.expectedHome}|/bin/sh|literal $value`,
						);
					}
				})(),
			),
	);
	it("preserves actual nonzero exit and stderr for missing files", () =>
		trackReload(
			(async () => {
				const invocation = { argv: [`cat -- ${quoteShellArgument(fixture.remoteMissing)}`] };
				const direct = await fixture.direct.run(invocation);
				const wrapped = await fixture.wrapped.run(invocation);
				expect(direct.exitCode).not.toBe(0);
				expect(direct.stderr).toContain("missing.txt");
				expect(wrapped).toEqual(direct);
			})(),
		));
	it("keeps deadlines, signals, unknown commands mentioning stat, and public open on the real wrapper", () =>
		trackReload(
			(async () => {
				const command = `cat -- ${quoteShellArgument(fixture.remoteFile)}`;
				await fixture.direct.run({ argv: [command], signal: new AbortController().signal });
				await fixture.direct.run({ argv: [command], timeoutMs: 5000 });
				await fixture.direct.run({ argv: ["printf stat"] });
				await fixture.direct.run({ argv: [`${command}; printf stat`] });
				expect(readFileSync(fixture.marker, "utf8")).toBe("wrappedwrappedwrappedwrapped");
				const chunks: Uint8Array[] = [];
				const channel = fixture.direct.open!({ argv: [command], onStdout: (data) => chunks.push(data) });
				channel.end();
				expect((await channel.exited).exitCode).toBe(0);
				expect(Buffer.concat(chunks)).toEqual(fixture.data);
				expect(readFileSync(fixture.marker, "utf8")).toBe("wrappedwrappedwrappedwrappedwrapped");
			})(),
		));
	it("serializes concurrent real commands and isolates per-request environment and cwd", () =>
		trackReload(
			(async () => {
				const command = `cat -- ${quoteShellArgument(fixture.remoteFile)}`;
				const results = await Promise.all([
					fixture.direct.run({
						argv: [
							buildListDirectoryCommand(
								fixture.remoteDataDirectory,
								process.platform === "darwin" ? "bsd" : "gnu",
							),
						],
					}),
					fixture.direct.run({ argv: [command], env: { DIFF_ENV: "first-only" } }),
					fixture.direct.run({ argv: [command] }),
				]);
				expect(results.every((result) => result.exitCode === 0)).toBe(true);
				expect(Buffer.from(results[1].stdout)).toEqual(fixture.data);
				expect(Buffer.from(results[2].stdout)).toEqual(fixture.data);
				expect(readFileSync(fixture.envMarker, "utf8")).toBe(`${fixture.expectedHome}|/bin/sh|`);
				expect(() => readFileSync(fixture.marker)).toThrow();
			})(),
		));

	it("stdin and streaming callbacks use the original SSH wrapper", () =>
		trackReload(
			(async () => {
				const command = `cat -- ${quoteShellArgument(fixture.remoteFile)}`;
				await fixture.direct.run({ argv: [command], stdin: Buffer.from("unused") });
				const chunks: Uint8Array[] = [];
				const streamed = await fixture.direct.run({ argv: [command], onStdout: (chunk) => chunks.push(chunk) });
				expect(streamed.stdout.length).toBe(0);
				expect(Buffer.concat(chunks)).toEqual(fixture.data);
				expect(readFileSync(fixture.marker, "utf8")).toBe("wrappedwrapped");
			})(),
		));

	it.each(["graceful", "abort"] as const)(
		"%s closure waits for owned I/O or rejects it before deleting the result directory",
		(mode) =>
			trackReload(
				(async () => {
					const gate = join(fixture.directory, "release.gate");
					const started = join(fixture.directory, "started.gate");
					writeFileSync(
						fixture.catPath,
						[
							"#!/bin/sh",
							`printf started > ${quoteShellArgument(posix.join(fixture.remoteDirectory, "started.gate"))}`,
							`while [ ! -f ${quoteShellArgument(posix.join(fixture.remoteDirectory, "release.gate"))} ]; do sleep 0.01; done`,
							'exec /bin/cat "$@"',
						].join("\n"),
					);
					const error = new Error("owned readonly endpoint abort");
					let onStarted!: () => void;
					const observed = new Promise<void>((resolve) => {
						onStarted = resolve;
					});
					const observer = setInterval(() => {
						if (existsSync(started)) onStarted();
					}, 10);
					const loading = fixture.direct.run({ argv: [`cat -- ${quoteShellArgument(fixture.remoteFile)}`] });
					let closing: Promise<void> | undefined;
					try {
						await Promise.race([
							observed,
							loading.then(() => {
								throw new Error("Owned gate did not block the command");
							}),
						]);
						let finished = false;
						closing = fixture.direct.closeReadonlyEndpoint(mode === "abort" ? error : undefined);
						void closing.then(
							() => {
								finished = true;
							},
							() => {
								finished = true;
							},
						);
						await expect(
							fixture.direct.run({ argv: [`cat -- ${quoteShellArgument(fixture.remoteFile)}`] }),
						).rejects.toThrow("closing");
						if (mode === "graceful") {
							expect(finished).toBe(false);
							expect(readdirSync(fixture.directory).some((name) => name.startsWith("readonly-"))).toBe(true);
							writeFileSync(gate, "released");
							expect(Buffer.from((await loading).stdout)).toEqual(fixture.data);
							await closing;
						} else {
							await expect(loading).rejects.toBe(error);
							await expect(closing).rejects.toBe(error);
						}
						expect(readdirSync(fixture.directory).some((name) => name.startsWith("readonly-"))).toBe(false);
					} finally {
						clearInterval(observer);
						writeFileSync(gate, "released");
						await Promise.allSettled([loading, ...(closing ? [closing] : [])]);
					}
				})(),
			),
	);

	it.each(["directory-failure", "missing-executable", "unexpected-zero-exit", "invalid-frame"] as const)(
		"%s rejects pending requests, including a concurrent close, and cleans only after real closure",
		(failure) =>
			trackReload(
				(async () => {
					const runner = createShellLoopbackRunner({
						...fixture.options,
						fileShellBinary:
							failure === "missing-executable"
								? join(fixture.directory, "missing-shell")
								: fixture.fileShellBinary,
						fileResultRoot: {
							native:
								failure === "directory-failure" ? join(fixture.directory, "missing-parent") : fixture.directory,
							remote: fixture.remoteDirectory,
						},
						...(failure === "invalid-frame"
							? {
									readonlyWorkerScriptForTests:
										'directory=$1; printf "ready\\n"; IFS= read -r request; ( . "$directory/$request.sh" ) </dev/null >"$directory/$request.out" 2>"$directory/$request.err"; printf "invalid\\ndone %s 0\\n" "$request"; IFS= read -r next',
								}
							: {}),
						...(failure === "unexpected-zero-exit"
							? { readonlyWorkerScriptForTests: 'printf "ready\\n"; IFS= read -r request; exit 0' }
							: {}),
					});
					const command = `cat -- ${quoteShellArgument(fixture.remoteFile)}`;
					const reads = [runner.run({ argv: [command] }), runner.run({ argv: [command] })];
					const handledReads = Promise.allSettled(reads);
					await new Promise<void>((resolve) => {
						const timer = setInterval(() => {
							if (
								readdirSync(fixture.directory).some((name) => name.startsWith("readonly-")) ||
								failure === "directory-failure"
							) {
								clearInterval(timer);
								resolve();
							}
						}, 5);
					});
					const closing = runner.closeReadonlyEndpoint();
					const results = [...(await handledReads), ...(await Promise.allSettled([closing]))];
					expect(results.every((result) => result.status === "rejected")).toBe(true);
					expect(readdirSync(fixture.directory).some((name) => name.startsWith("readonly-"))).toBe(false);
				})(),
			),
	);
	it("a failed closure verification remains sticky across repeated close and later queries", () =>
		trackReload(
			(async () => {
				const error = new Error("owned close verification failed");
				const runner = createShellLoopbackRunner({
					...fixture.options,
					fileShellBinary: fixture.fileShellBinary,
					fileResultRoot: { native: fixture.directory, remote: fixture.remoteDirectory },
					readonlyWorkerScriptForTests: 'printf "ready\\n"; IFS= read -r request; exit 0',
					verifyReadonlyCloseForTests: async () => {
						throw error;
					},
				});
				const invocation = { argv: [`cat -- ${quoteShellArgument(fixture.remoteFile)}`] };
				const failure: unknown = await runner.run(invocation).catch((reason: unknown) => reason);
				expect(failure).toBeInstanceOf(Error);
				await expect(runner.closeReadonlyEndpoint()).rejects.toBe(failure);
				await expect(runner.closeReadonlyEndpoint()).rejects.toBe(failure);
				await expect(runner.run(invocation)).rejects.toBe(failure);
				expect(readdirSync(fixture.directory).some((name) => name.startsWith("readonly-"))).toBe(true);
				const resultDirectory = readdirSync(fixture.directory).find((name) => name.startsWith("readonly-"))!;
				expect(readdirSync(join(fixture.directory, resultDirectory))).toContain("1.sh");
				// Only the post-close verifier is injected: the actual worker EOF/close has already completed.
			})(),
		));
});

describe("远程项目会话的资源发现", { timeout: 60_000 }, () => {
	it("读到远端项目自己的 AGENTS.md 与项目技能，不读本机的", async () => {
		const reads = {
			stat: vi.spyOn(connection, "stat"),
			readText: vi.spyOn(connection, "readFile"),
			realPath: vi.spyOn(connection, "realPath"),
		};
		const { remotePath, agentDir } = resourceFixture();

		const { resourceSource } = await trackReload(
			createDesktopPromptRuntimeSources({
				cwd: `ssh://build-01${remotePath}`,
				agentDir,
				sessionOptions: { includeAgentSkills: true },
				runtimeSkillPaths: [],
			} as never),
		);

		const agentsFiles = resourceSource.getAgentsFiles().agentsFiles;
		expect(agentsFiles.map((file) => file.content)).toContain("REMOTE-PROJECT-RULES\n");
		// 这条测试自己就跑在一个带 AGENTS.md 的仓库里：旧实现会把 URI 解析到进程 cwd 之下，
		// 再沿本机祖先目录向上，把本仓库的 AGENTS.md 当成远端项目的规则读进来。
		expect(agentsFiles.every((file) => file.path.startsWith(remotePath) || file.path.startsWith(agentDir))).toBe(
			true,
		);
		const deploy = resourceSource.getSkills().skills.find((skill) => skill.name === "deploy");
		expect(resourceSource.getSkills().skills.map((skill) => skill.name)).toEqual(["deploy"]);
		// 模型会把这条路径直接交给跑在远端的 bash：必须是那台机器上的绝对路径，不是 URI。
		expect(deploy?.baseDir).toBe(posix.join(remotePath, ".agents/skills/deploy"));
		expect(deploy?.filePath).toBe(posix.join(remotePath, ".agents/skills/deploy/SKILL.md"));
		console.info(
			"[remote-resource-read] completed actual loopback queries",
			Object.fromEntries(Object.entries(reads).map(([operation, query]) => [operation, query.mock.calls.length])),
		);
		for (const query of Object.values(reads)) {
			const paths = query.mock.calls.map(([path]) => path);
			expect(new Set(paths).size).toBe(paths.length);
		}
	});
});

describe("已加载的远程资源再次刷新", { timeout: 60_000 }, () => {
	let fixture: ReturnType<typeof resourceFixture>;
	let source: SessionResourceRuntime;
	let reads: ReturnType<typeof watchResourceReads>;
	const report = (phase: string, started: number) =>
		console.info("[remote-resource-refresh]", {
			phase,
			elapsedMs: Date.now() - started,
			...Object.fromEntries(Object.entries(reads).map(([operation, query]) => [operation, query.mock.calls.length])),
		});
	beforeEach(async () => {
		fixture = resourceFixture();
		reads = {
			stat: vi.spyOn(connection, "stat"),
			readText: vi.spyOn(connection, "readFile"),
			realPath: vi.spyOn(connection, "realPath"),
		};
		const started = Date.now();
		report("hook:start", started);
		// The composition view is read-only; this real Desktop factory returns its full session runtime.
		source = (
			await trackReload(
				createDesktopPromptRuntimeSources({
					cwd: `ssh://build-01${fixture.remotePath}`,
					agentDir: fixture.agentDir,
					sessionOptions: { includeAgentSkills: true },
					runtimeSkillPaths: [],
				} as never),
			)
		).resourceSource as SessionResourceRuntime;
		report("hook:end", started);
		for (const query of Object.values(reads)) query.mockClear();
	});
	it("修改 AGENTS 与 SKILL 后一次 reload 读到真实新内容和正确远端路径", async () => {
		expect(source.getAgentsFiles().agentsFiles.map((file) => file.content)).toContain("REMOTE-PROJECT-RULES\n");
		writeFileSync(join(fixture.remoteRoot, "AGENTS.md"), "UPDATED-PROJECT-RULES\n");
		writeFileSync(
			join(fixture.remoteRoot, ".agents/skills/deploy/SKILL.md"),
			"---\nname: deploy\ndescription: Updated remote service.\n---\n\nRun the updated script.\n",
		);
		const started = Date.now();
		report("body:start", started);
		const loading = trackReload(source.reload());
		try {
			await loading;
		} finally {
			report("body:end", started);
		}
		const agents = source.getAgentsFiles().agentsFiles;
		expect(agents.map((file) => file.content)).toContain("UPDATED-PROJECT-RULES\n");
		expect(agents.map((file) => file.content)).not.toContain("REMOTE-PROJECT-RULES\n");
		expect(
			agents.every((file) => file.path.startsWith(fixture.remotePath) || file.path.startsWith(fixture.agentDir)),
		).toBe(true);
		const skill = source.getSkills().skills.find((skill) => skill.name === "deploy");
		expect(skill?.description).toBe("Updated remote service.");
		expect(skill?.filePath).toBe(posix.join(fixture.remotePath, ".agents/skills/deploy/SKILL.md"));
		expect(skill?.baseDir).toBe(posix.join(fixture.remotePath, ".agents/skills/deploy"));
	});
});

it(
	"cleanup waits for owned initial I/O before removing files or restoring env and preserves caller rejection",
	{ timeout: 60_000 },
	async () => {
		const directory = temporaryDirectory(tmpdir(), "resource-cleanup-observation-");
		const marker = join(directory, "owned.txt");
		writeFileSync(marker, "actual owned data");
		const previousHome = process.env.VETTA_HOME;
		vi.stubEnv("VETTA_HOME", directory);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loading = trackReload(gate.then(() => readFile(marker, "utf8")));
		let finished = false;
		const cleanup = cleanupResources().then(() => {
			finished = true;
		});
		try {
			await Promise.resolve();
			expect(finished).toBe(false);
			expect(process.env.VETTA_HOME).toBe(directory);
			expect(await readFile(marker, "utf8")).toBe("actual owned data");
			release();
			expect(await loading).toBe("actual owned data");
			await cleanup;
			expect(process.env.VETTA_HOME).toBe(previousHome);
			await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			release();
			await Promise.allSettled([loading, cleanup]);
		}
		const error = new Error("owned loader failed");
		const failure = trackReload(Promise.reject(error));
		await expect(failure).rejects.toBe(error);
		await cleanupResources();
	},
);
