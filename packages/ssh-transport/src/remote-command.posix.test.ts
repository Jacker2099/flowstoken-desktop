// Native POSIX endpoint contract; selected on macOS/Linux by the release SSH matrix.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseRemoteDirectoryListing } from "./directory-listing.js";
import {
	buildCreateEntryCommand,
	buildKillCommand,
	buildListDirectoryCommand,
	buildListFilesRecursiveCommand,
	buildRemoteCommand,
	buildStatCommand,
	buildWriteFileCommand,
	REMOTE_ENTRY_EXISTS_EXIT_CODE,
} from "./remote-command.js";
import { assertNativePosixTestHost } from "./testing-platform.js";

assertNativePosixTestHost();

describe("buildRemoteCommand（在真实 /bin/sh 上执行）", () => {
	// 引用有两层，断言字符串只能证明「长得像」。真正的合同是：交给 shell 之后，用户命令
	// 在正确的目录里、由登录 shell 执行，退出码原样回来。
	const run = (remoteCommand: string, env: NodeJS.ProcessEnv = {}) =>
		spawnSync("/bin/sh", ["-c", remoteCommand], { encoding: "utf8", env: { ...process.env, ...env } });

	it("走账号的登录 shell，让 nvm、pyenv 这类只改 profile 的 PATH 生效", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-shell-"));
		const fakeShell = join(dir, "fake-shell");
		writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s|" "$@"\n');
		chmodSync(fakeShell, 0o755);
		expect(run(buildRemoteCommand("node -v"), { SHELL: fakeShell }).stdout).toBe("-l|-c|node -v|");
	});

	it("cd 与用户命令作为一个整体执行，&& 不会落到外层", () => {
		// 直接把 `cd x && cmd` 摊在 -c 外面，cmd 就跑在了家目录而不是项目里。
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetta it's-")));
		const result = run(buildRemoteCommand("pwd; exit 3", { cwd: dir }), { SHELL: "/bin/sh" });
		expect(result.stdout.trim()).toBe(dir);
		expect(result.status).toBe(3);
	});

	it("带 processToken 时退出码照旧，结束后不留记号文件", () => {
		const tmp = mkdtempSync(join(tmpdir(), "vetta-token-"));
		const result = run(buildRemoteCommand("exit 7", { processToken: "vetta-exec-t1" }), {
			SHELL: "/bin/sh",
			TMPDIR: tmp,
		});
		expect(result.status).toBe(7);
		expect(readdirSync(tmp)).toEqual([]);
	});
});

describe("buildKillCommand（在真实 /bin/sh 上执行）", () => {
	it("连同派生的子进程一起杀掉——只杀领头进程会把 dev server 留成孤儿", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "vetta-kill-"));
		const env = { ...process.env, SHELL: "/bin/sh", TMPDIR: tmp };
		const marker = join(tmp, "child.pid");
		// detached 让它自成一个会话，与 sshd 为无 pty 会话做的 setsid() 同构。
		const child = spawn(
			"/bin/sh",
			[
				"-c",
				buildRemoteCommand(`sh -c 'echo $$ > ${marker}; sleep 60' & sleep 60`, { processToken: "vetta-exec-k1" }),
			],
			{ env, detached: true, stdio: "ignore" },
		);
		const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
		await vi.waitFor(() => expect(existsSync(marker) && readFileSync(marker, "utf8").trim()).toBeTruthy());
		const grandchildPid = Number(readFileSync(marker, "utf8").trim());

		execFileSync("/bin/sh", ["-c", buildKillCommand("vetta-exec-k1")], { env });

		await exited;
		await vi.waitFor(() => expect(() => process.kill(grandchildPid, 0)).toThrow());
		expect(readdirSync(tmp)).toEqual(["child.pid"]);
	});

	it("命令不在自己的会话里时只记单个进程，绝不整组终止——那个组里还有别人", async () => {
		// 回归：没有 setsid 的环境下，记到的进程组是启动者的组；整组 TERM 会把同组的其它进程
		// （这里就是测试运行器自己）一并杀掉。
		const tmp = mkdtempSync(join(tmpdir(), "vetta-kill-"));
		const env = { ...process.env, SHELL: "/bin/sh", TMPDIR: tmp };
		const child = spawn("/bin/sh", ["-c", buildRemoteCommand("sleep 60", { processToken: "vetta-exec-k2" })], {
			env,
			stdio: "ignore",
		});
		const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
		await vi.waitFor(() => expect(existsSync(join(tmp, "vetta-exec-k2"))).toBe(true));
		expect(readFileSync(join(tmp, "vetta-exec-k2"), "utf8")).toMatch(/^p\d+$/);

		execFileSync("/bin/sh", ["-c", buildKillCommand("vetta-exec-k2")], { env });

		await exited; // 走到这里说明被杀的只是那条命令，而不是我们自己。
	});

	it("记号文件不存在或内容不是进程号时什么都不做", () => {
		const tmp = mkdtempSync(join(tmpdir(), "vetta-kill-"));
		const env = { ...process.env, TMPDIR: tmp };
		expect(() => execFileSync("/bin/sh", ["-c", buildKillCommand("vetta-exec-none")], { env })).not.toThrow();
		// `kill -- -1` 会杀掉该用户的全部进程，必须被挡在外面。
		writeFileSync(join(tmp, "vetta-exec-bad"), "g1");
		expect(() => execFileSync("/bin/sh", ["-c", buildKillCommand("vetta-exec-bad")], { env })).not.toThrow();
	});
});

describe("buildWriteFileCommand（在真实 /bin/sh 上执行）", () => {
	// 这段脚本的正确性取决于 shell 的真实语义（截断是否保留 mode、mv 对符号链接做什么），
	// 断言字符串证明不了任何事，所以直接在本机 sh 上跑。
	function write(target: string, content: string): void {
		execFileSync("/bin/sh", ["-c", buildWriteFileCommand(target, ".vetta-tmp-test")], { input: content });
	}

	it("新文件直接落盘，不留临时文件", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-write-"));
		write(join(dir, "a b'c.txt"), "hello");
		expect(readFileSync(join(dir, "a b'c.txt"), "utf8")).toBe("hello");
		expect(readdirSync(dir)).toEqual(["a b'c.txt"]);
	});

	it("覆盖可执行脚本后仍然可执行", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-write-"));
		const script = join(dir, "run.sh");
		writeFileSync(script, "old");
		chmodSync(script, 0o755);
		write(script, "new");
		expect(readFileSync(script, "utf8")).toBe("new");
		expect(statSync(script).mode & 0o777).toBe(0o755);
	});

	it("写符号链接时改的是它指向的文件，链接本身保持为链接", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-write-"));
		const real = join(dir, "real.txt");
		const link = join(dir, "link.txt");
		writeFileSync(real, "old");
		symlinkSync(real, link);
		write(link, "new");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, "utf8")).toBe("new");
	});

	it("目录不存在时失败，且不留下临时文件", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-write-"));
		expect(() => write(join(dir, "missing", "a.txt"), "x")).toThrow();
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("stat 与目录列举（在真实 shell 上执行并解析）", () => {
	// 格式串的转义规则 GNU 与 BSD 不同，只有真的跑一遍才知道输出能不能被解析。
	const flavor = process.platform === "darwin" ? "bsd" : "gnu";
	const run = (command: string): string => execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });

	it("本机这一家的 stat 输出能被解析成条目", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-stat-"));
		writeFileSync(join(dir, "a b.txt"), "hello");
		mkdirSync(join(dir, "src"));

		const entries = parseRemoteDirectoryListing(run(buildListDirectoryCommand(dir, flavor)));
		expect(entries.map((entry) => [entry.name, entry.kind]).sort()).toEqual([
			["a b.txt", "file"],
			["src", "directory"],
		]);
		expect(entries.find((entry) => entry.name === "a b.txt")?.sizeBytes).toBe(5);

		expect(parseRemoteDirectoryListing(run(buildStatCommand(dir, flavor)))[0]?.kind).toBe("directory");
		expect(run(buildStatCommand(join(dir, "missing"), flavor))).toBe("");
	});
});

describe("文件树操作（在真实 shell 上执行）", () => {
	const run = (command: string) => spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

	it("独占创建：新建成功，目标已存在时用约定的退出码拒绝且不动原文件", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-create-"));
		expect(run(buildCreateEntryCommand(join(dir, "it's new.txt"), "file")).status).toBe(0);
		expect(readFileSync(join(dir, "it's new.txt"), "utf8")).toBe("");
		expect(run(buildCreateEntryCommand(join(dir, "src"), "directory")).status).toBe(0);
		expect(statSync(join(dir, "src")).isDirectory()).toBe(true);

		writeFileSync(join(dir, "keep.txt"), "precious");
		expect(run(buildCreateEntryCommand(join(dir, "keep.txt"), "file")).status).toBe(REMOTE_ENTRY_EXISTS_EXIT_CODE);
		expect(run(buildCreateEntryCommand(join(dir, "src"), "directory")).status).toBe(REMOTE_ENTRY_EXISTS_EXIT_CODE);
		expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("precious");
	});

	it("递归列举跳过点开头的条目与忽略目录，且不会因为起点是 . 而把整棵树剪掉", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-walk-"));
		for (const sub of ["src/deep", "node_modules/pkg", ".git"]) mkdirSync(join(dir, sub), { recursive: true });
		writeFileSync(join(dir, "README.md"), "");
		writeFileSync(join(dir, "src/deep/a b.ts"), "");
		writeFileSync(join(dir, "node_modules/pkg/index.js"), "");
		writeFileSync(join(dir, ".git/config"), "");
		writeFileSync(join(dir, ".env"), "");

		const command = buildListFilesRecursiveCommand(dir, { ignoredDirectoryNames: ["node_modules"], limit: 100 });
		expect(run(command).stdout.trim().split("\n").sort()).toEqual(["./README.md", "./src/deep/a b.ts"]);
	});

	it("递归列举到达上限就停", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-walk-"));
		for (let index = 0; index < 5; index++) writeFileSync(join(dir, `f${index}.txt`), "");
		const command = buildListFilesRecursiveCommand(dir, { ignoredDirectoryNames: [], limit: 2 });
		expect(run(command).stdout.trim().split("\n")).toHaveLength(2);
	});

	it("按文件名筛选时上限只算命中项，忽略目录里的同名文件不会混进来", () => {
		const dir = mkdtempSync(join(tmpdir(), "vetta-walk-"));
		for (const sub of ["a/src", "b", "node_modules/x"]) mkdirSync(join(dir, sub), { recursive: true });
		for (let index = 0; index < 5; index++) writeFileSync(join(dir, `a/src/f${index}.ts`), "");
		writeFileSync(join(dir, "a/package.json"), "");
		writeFileSync(join(dir, "b/Makefile"), "");
		writeFileSync(join(dir, "node_modules/x/package.json"), "");

		const command = buildListFilesRecursiveCommand(dir, {
			ignoredDirectoryNames: ["node_modules"],
			limit: 2,
			names: ["package.json", "Makefile"],
		});
		expect(run(command).stdout.trim().split("\n").sort()).toEqual(["./a/package.json", "./b/Makefile"]);
	});
});
