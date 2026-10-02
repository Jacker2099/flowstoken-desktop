import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeSshProcessRunner } from "./node-process-runner.js";
import { formatSshProjectUri } from "./project-uri.js";
import { SshConnection, type SshConnectionOptions } from "./ssh-connection.js";
import { createShellLoopbackRunner, terminateWindowsLoopbackTree } from "./testing-process-runner.js";

/**
 * 一条「连到本机」的 SSH 连接，不需要 sshd。仅供测试使用。
 *
 * 顶替 `ssh` 的脚本只认最后一个参数并把它交给 `/bin/sh -c`——这正是 sshd 对远端命令做的
 * 事。于是「远端」就是本机的一个临时目录，命令构造、两层引用、字节往返与退出码都跑在真实
 * shell 上。Windows 使用真实 Git usr/bin/sh 直接解释同一完整末参数，省去测试专属
 * bin launcher 与 fakeSSH 外壳；生产命令里的登录 shell 和 marker 保持原样。
 * 测试证明的是功能真的可用，而不是我们拼出了预期的字符串、调用了自己写的 mock。
 * 它已经抓出过 BSD stat 不解释 `\t` 这类只有真跑才会暴露的问题。
 */
export function createLoopbackSshConnection(
	hostId = "loopback",
	options: Pick<SshConnectionOptions, "helper"> & {
		readonly commandDirectory?: string;
		/** Resource-only Windows fixture: avoid redundant shells for exact readonly file scripts. */
		readonly directFileCommands?: boolean;
		/** A/B control for the old Windows bin launcher and fake-SSH shell. */
		readonly legacyCommandEndpoint?: boolean;
	} = {},
): SshConnection & {
	closeReadonlyEndpoint(): Promise<void>;
	waitForIdle(): Promise<void>;
	abortOwnedOperations(): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "vetta-loopback-ssh-"));
	// 「远端」有自己的家目录：helper 会往 ~/.cache 里装东西，不能装进开发者真实的家目录。
	const home = join(directory, "home");
	mkdirSync(home);
	const fakeSsh = join(directory, "ssh");
	// sshd 为每条无 pty 的会话调用 setsid()；远端命令的「整组终止」依赖这一点。回环里用 perl
	// 补上同样的一步，否则命令会落在测试运行器自己的进程组里。没有 perl 时不建新会话——
	// 终止逻辑自带保险，只会退化为杀单个进程，不会误伤。
	writeFileSync(
		fakeSsh,
		[
			"#!/bin/sh",
			"for last; do :; done",
			`if [ -n "\${VETTA_LOOPBACK_COMMAND_DIRECTORY:-}" ]; then export PATH="$VETTA_LOOPBACK_COMMAND_DIRECTORY:$PATH"; fi`,
			`if [ "\${VETTA_LOOPBACK_WINDOWS:-}" != 1 ] && command -v perl >/dev/null 2>&1; then`,
			"  exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/sh -c \"$last\"",
			"fi",
			'exec /bin/sh -c "$last"',
			"",
		].join("\n"),
	);
	chmodSync(fakeSsh, 0o755);
	const baseEnv = {
		...process.env,
		SHELL: "/bin/sh",
		HOME: loopbackRemotePath(home),
		TMPDIR: loopbackRemotePath(directory),
		...(options.commandDirectory === undefined
			? {}
			: { VETTA_LOOPBACK_COMMAND_DIRECTORY: loopbackRemotePath(options.commandDirectory) }),
	};
	const fileShellBinary =
		process.platform === "win32" && options.directFileCommands
			? join(dirname(gitBashTools().cygpath), "sh.exe")
			: undefined;
	if (fileShellBinary && !existsSync(fileShellBinary)) throw new Error("Loopback file endpoint requires Git sh.exe");
	const commandShellBinary =
		process.platform === "win32" && !options.legacyCommandEndpoint
			? join(dirname(gitBashTools().cygpath), "sh.exe")
			: undefined;
	if (commandShellBinary && !existsSync(commandShellBinary))
		throw new Error("Loopback command endpoint requires Git sh.exe");
	const pending = new Set<Promise<unknown>>();
	const controllers = new Set<AbortController>();
	const runner =
		process.platform === "win32"
			? createShellLoopbackRunner({
					shellBinary: loopbackShellBinary(),
					scriptPath: loopbackRemotePath(fakeSsh),
					baseEnv: { ...baseEnv, VETTA_LOOPBACK_WINDOWS: "1" },
					terminateTree: terminateWindowsLoopbackTree,
					fileShellBinary,
					commandShellBinary,
					fileResultRoot: fileShellBinary
						? { native: directory, remote: loopbackRemotePath(directory) }
						: undefined,
				})
			: createNodeSshProcessRunner({ sshBinary: fakeSsh, baseEnv });
	const run = runner.run.bind(runner);
	runner.run = (invocation) => {
		const controller = process.platform === "win32" ? undefined : new AbortController();
		const abort = () => controller?.abort();
		if (controller) {
			controllers.add(controller);
			if (invocation.signal?.aborted) controller.abort();
			invocation.signal?.addEventListener("abort", abort, { once: true });
		}
		const result = run(controller ? { ...invocation, signal: controller.signal } : invocation);
		pending.add(result);
		const finished = () => {
			pending.delete(result);
			if (controller) controllers.delete(controller);
			invocation.signal?.removeEventListener("abort", abort);
		};
		void result.then(finished, finished);
		return result;
	};
	const connection = new SshConnection(
		{ id: hostId, label: hostId, target: hostId, source: "manual" },
		{
			// 固定 /bin/sh 当登录 shell：开发者自己的 zsh profile 既慢，又让结果因人而异。
			runner,
			controlPath: join(directory, "cp"),
			helper: options.helper,
		},
	);
	return Object.assign(connection, {
		abortOwnedOperations: () => {
			for (const controller of controllers) controller.abort();
			if ("abortOwnedOperations" in runner && typeof runner.abortOwnedOperations === "function")
				runner.abortOwnedOperations();
		},
		waitForIdle: async () => {
			while (pending.size > 0) await Promise.allSettled([...pending]);
			if ("waitForIdle" in runner && typeof runner.waitForIdle === "function") await runner.waitForIdle();
		},
		closeReadonlyEndpoint: async () => {
			if ("closeReadonlyEndpoint" in runner && typeof runner.closeReadonlyEndpoint === "function") {
				await runner.closeReadonlyEndpoint();
			}
		},
	});
}

export {
	acceptOwnedJobReady,
	stopOwnedJob,
	waitForOwnedJobEmpty,
	waitForOwnedSupervisorLaunch,
} from "./testing-owned-job.js";
// These helpers are exported only by the testing entry point, never the production entry point.
export { createShellLoopbackRunner, terminateWindowsLoopbackTree } from "./testing-process-runner.js";
export { createOwnedJobFromNativeCallsForTests } from "./testing-windows-job.js";
export { openOwnedWindowsProcessWitness } from "./testing-windows-witness.js";

export function loopbackShellBinary(): string {
	return process.platform === "win32" ? gitBashTools().bash : "/bin/sh";
}

/** Native paths belong to Node fs; paths passed to the loopback remote host are always POSIX. */
export function loopbackRemotePath(localPath: string): string {
	if (process.platform !== "win32") return localPath;
	return execFileSync(gitBashTools().cygpath, ["-u", "--", localPath], { encoding: "utf8" }).trim();
}

// Both names share the same Git Bash path conversion; upstream consumers use the former.
export const toLoopbackRemotePath = loopbackRemotePath;

/** Own a complete test flow, including startup that can finish after a test timeout. */
export function createLoopbackTestScope() {
	let closing = false;
	let cleanup: Promise<void> | undefined;
	const pending = new Set<Promise<unknown>>();
	const starts = new Set<Promise<unknown>>();
	const releases: (() => void)[] = [];
	const stops: (() => Promise<void>)[] = [];
	const closedError = new Error("Owned loopback test is closing");
	let rejectClosed: (error: Error) => void = () => {};
	const closed = new Promise<never>((_resolve, reject) => {
		rejectClosed = reject;
	});
	void closed.catch(() => {});
	const track = <T>(task: Promise<T>): Promise<T> => {
		pending.add(task);
		void task.then(
			() => pending.delete(task),
			() => pending.delete(task),
		);
		return task;
	};
	const assertOpen = (): void => {
		if (closing) throw closedError;
	};
	return {
		track,
		assertOpen,
		step<T>(operation: () => Promise<T>): Promise<T> {
			assertOpen();
			return track(
				operation().then((value) => {
					assertOpen();
					return value;
				}),
			);
		},
		start<T>(operation: () => Promise<T>, stop: (value: T) => Promise<void>): Promise<T> {
			assertOpen();
			const starting = operation().then((value) => {
				stops.push(() => stop(value));
				assertOpen();
				return value;
			});
			starts.add(starting);
			void starting.then(
				() => starts.delete(starting),
				() => starts.delete(starting),
			);
			return track(starting);
		},
		until(check: () => void, wait: (check: () => void) => Promise<unknown>): Promise<unknown> {
			assertOpen();
			const waiting = wait(() => {
				if (!closing) check();
			});
			return track(Promise.race([waiting, closed]));
		},
		onClosing(release: () => void) {
			releases.push(release);
		},
		onCleanup(stop: () => Promise<void>) {
			stops.push(stop);
		},
		close(idle: () => Promise<void>): Promise<void> {
			if (cleanup) return cleanup;
			closing = true;
			rejectClosed(closedError);
			cleanup = (async () => {
				const failures: unknown[] = [];
				for (const release of releases.splice(0)) {
					try {
						release();
					} catch (error) {
						failures.push(error);
					}
				}
				await Promise.allSettled([...starts]);
				while (stops.length > 0) {
					for (const result of await Promise.allSettled(
						stops.splice(0).map((stop) => Promise.resolve().then(stop)),
					))
						if (result.status === "rejected") failures.push(result.reason);
				}
				while (pending.size > 0) await Promise.allSettled([...pending]);
				try {
					await idle();
				} catch (error) {
					failures.push(error);
				}
				if (failures.length > 0) throw failures[0];
			})();
			return cleanup;
		},
	};
}

export function formatLoopbackProjectUri(hostId: string, localPath: string): string {
	return formatSshProjectUri(hostId, toLoopbackRemotePath(localPath));
}

/** Test-only Windows endpoint; POSIX hosts retain their existing native process runner. */
export function loopbackCommandShellBinary(): string | undefined {
	return process.platform === "win32" ? join(dirname(gitBashTools().cygpath), "sh.exe") : undefined;
}

let cachedGitBash: { bash: string; cygpath: string } | undefined;

function gitBashTools(): { bash: string; cygpath: string } {
	if (cachedGitBash) return cachedGitBash;
	const gitPaths = spawnSync("where.exe", ["git.exe"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/) ?? [];
	const roots = [
		...gitPaths.map((path) => resolve(dirname(path), "..")),
		...[process.env.ProgramFiles, process.env.ProgramW6432, process.env.LOCALAPPDATA]
			.filter((path): path is string => Boolean(path))
			.map((path) => join(path, "Git")),
	];
	for (const root of roots) {
		const bash = join(root, "bin", "bash.exe");
		const cygpath = join(root, "usr", "bin", "cygpath.exe");
		if (existsSync(bash) && existsSync(cygpath)) {
			cachedGitBash = { bash, cygpath };
			return cachedGitBash;
		}
	}
	throw new Error("Loopback SSH tests require Git for Windows (bash.exe and cygpath.exe)");
}

let builtHelper: string | undefined | null = null;

/**
 * 编译一份本机平台的远端 helper 供端到端测试使用；没有 Go 工具链时返回 undefined，
 * 调用方据此跳过。同一进程内只编一次。
 */
export function buildSshHelperForTests(): string | undefined {
	if (builtHelper !== null) return builtHelper;
	const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/ssh-helper");
	const output = join(mkdtempSync(join(tmpdir(), "vetta-helper-build-")), "vetta-ssh-helper");
	const result = spawnSync("go", ["build", "-o", output, "./cmd/vetta-ssh-helper"], {
		cwd: source,
		env: { ...process.env, CGO_ENABLED: "0" },
	});
	builtHelper = result.status === 0 ? output : undefined;
	return builtHelper;
}
