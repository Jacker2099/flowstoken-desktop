import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoopbackSshConnection,
	createLoopbackTestScope,
	formatLoopbackProjectUri,
} from "@vetta/ssh-transport/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const connection = createLoopbackSshConnection();
vi.mock("../ssh/ssh-runtime.js", () => ({ getSshConnection: () => connection }));

const { runRemotePluginCommand } = await import("./remote-command-runner.js");
const directories: string[] = [];
const scopes: ReturnType<typeof createCommandScope>[] = [];

function createCommandScope() {
	const scope = createLoopbackTestScope();
	scope.onClosing(() => connection.abortOwnedOperations());
	return Object.assign(scope, {
		command: (request: Parameters<typeof runRemotePluginCommand>[0]) =>
			scope.step(() => runRemotePluginCommand(request)),
	});
}

function ownedIt(
	name: string,
	body: (scope: ReturnType<typeof createCommandScope>) => Promise<void>,
	timeout?: number,
) {
	it(
		name,
		() => {
			const scope = createCommandScope();
			scopes.push(scope);
			return scope.track(body(scope));
		},
		timeout,
	);
}

afterEach(async () => {
	for (const scope of scopes.splice(0)) await scope.close(() => connection.waitForIdle());
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createRemoteRepository(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "vetta-remote-repo-")));
	directories.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, "it's new.txt"), "x");
	return root;
}

const limits = { env: undefined, timeoutMs: 20_000, maxBufferBytes: 1024 * 1024 };

describe("插件命令在远程项目所在的机器上执行", () => {
	ownedIt(
		"Git 面板的探测命令在远端仓库里回答「是仓库」，并看得到那里的改动",
		async (scope) => {
			const root = createRemoteRepository();
			const cwd = formatLoopbackProjectUri("build-01", root);

			const inside = await scope.command({
				...limits,
				file: "git",
				args: ["rev-parse", "--is-inside-work-tree"],
				cwd,
			});
			expect(inside).toMatchObject({ exitCode: 0, stdout: "true\n" });

			const status = await scope.command({ ...limits, file: "git", args: ["status", "--porcelain"], cwd });
			expect(status.stdout).toContain("it's new.txt");
		},
		20_000,
	);

	ownedIt("参数里的 shell 元字符按字面量到达命令", async (scope) => {
		const root = createRemoteRepository();
		const result = await scope.command({
			...limits,
			file: "printf",
			args: ["%s|", "$HOME", "a b", "x;y", "`id`"],
			cwd: formatLoopbackProjectUri("build-01", root),
		});
		expect(result.stdout).toBe("$HOME|a b|x;y|`id`|");
	});

	ownedIt("非零退出照常返回，由插件自己检查退出码", async (scope) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "vetta-remote-plain-")));
		directories.push(root);
		const result = await scope.command({
			...limits,
			file: "git",
			args: ["rev-parse", "--is-inside-work-tree"],
			cwd: formatLoopbackProjectUri("build-01", root),
		});
		expect(result.exitCode).not.toBe(0);
	});

	ownedIt("远端没有这个命令时，失败方式与本机「可执行文件不存在」一致", async (scope) => {
		const root = createRemoteRepository();
		await expect(
			scope.command({
				...limits,
				file: "vetta-no-such-command",
				args: [],
				cwd: formatLoopbackProjectUri("build-01", root),
			}),
		).rejects.toThrow(/Command failed to start: vetta-no-such-command \(ENOENT/);
	});

	ownedIt("只透传插件显式给出的环境变量", async (scope) => {
		const root = createRemoteRepository();
		const result = await scope.command({
			...limits,
			env: { VETTA_PLUGIN_FLAG: "on" },
			file: "sh",
			args: ["-c", 'printf %s "$VETTA_PLUGIN_FLAG"'],
			cwd: formatLoopbackProjectUri("build-01", root),
		});
		expect(result.stdout).toBe("on");
	});
});
