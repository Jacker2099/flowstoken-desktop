import { describe, expect, it } from "vitest";
import {
	buildKillCommand,
	buildListDirectoryCommand,
	buildRemoteCommand,
	buildRemoteScript,
	buildStatCommand,
	quoteShellArgument,
} from "./remote-command.js";

describe("quoteShellArgument", () => {
	it("中和掉远端 shell 会解释的每一类元字符", () => {
		// 路径来自用户选目录、模型给的参数和远端目录列表，任何一类漏掉都是任意命令执行。
		const cases = [
			"$(whoami)",
			"`id`",
			"a; rm -rf /",
			"a && rm -rf /",
			"a | tee /tmp/x",
			"a > /tmp/x",
			"$HOME",
			"a\nrm -rf /",
			"*",
			"~/secret",
			"a\\b",
		];
		for (const value of cases) {
			expect(quoteShellArgument(value)).toBe(`'${value}'`);
		}
	});

	it("用闭合再重开的方式处理单引号，引号逃不出字面量", () => {
		expect(quoteShellArgument("it's")).toBe("'it'\\''s'");
		// 经典逃逸尝试：靠一个单引号结束引用，后面接命令。
		expect(quoteShellArgument("'; rm -rf / #")).toBe("''\\''; rm -rf / #'");
	});

	it("保留空串与空白", () => {
		expect(quoteShellArgument("")).toBe("''");
		expect(quoteShellArgument("a b")).toBe("'a b'");
	});
});

describe("buildRemoteScript", () => {
	it("cd 用 && 连接，目录不存在就整条失败而不是落到家目录执行", () => {
		expect(buildRemoteScript("npm test", { cwd: "/srv/app" })).toBe("cd '/srv/app' && npm test");
	});

	it("工作目录里的引号不会把命令截断", () => {
		expect(buildRemoteScript("ls", { cwd: "/srv/it's here" })).toBe("cd '/srv/it'\\''s here' && ls");
	});

	it("环境变量值被引用，变量名非法时拒绝构造", () => {
		expect(buildRemoteScript("go build", { env: { GOFLAGS: "-tags 'a b'" } })).toBe(
			"export GOFLAGS='-tags '\\''a b'\\''' && go build",
		);
		expect(() => buildRemoteScript("ls", { env: { "A;B": "x" } })).toThrow("Invalid environment variable name");
	});
});

describe("buildListDirectoryCommand", () => {
	it("按远端 stat 方言选格式，不在远端用 || 试错", () => {
		// 试错会在第一条命令部分成功时给出半截输出，解析不出来也发现不了。
		expect(buildListDirectoryCommand("/srv", "gnu")).toContain("stat -c '");
		expect(buildListDirectoryCommand("/srv", "bsd")).toContain("-f ");
		expect(buildListDirectoryCommand("/srv", "gnu")).not.toContain("||");
	});

	it("目录路径被引用", () => {
		expect(buildListDirectoryCommand("/srv/a b", "gnu")).toContain("cd '/srv/a b'");
	});

	it("锁死 C locale，否则中文系统上 stat 会输出「目录」而不是 directory", () => {
		// 现场故障：远端是中文 locale，每个条目都被判成未知类型，目录列表显示为空，
		// 而且没有任何报错——从现象完全反推不到原因。
		expect(buildListDirectoryCommand("/srv", "gnu")).toContain("LC_ALL=C");
		expect(buildStatCommand("/srv/app", "gnu")).toContain("LC_ALL=C");
	});

	it("用 env 设置 locale，而不是 POSIX 的前缀赋值", () => {
		// `LC_ALL=C cmd` 是 POSIX shell 语法，远端登录 shell 若是 fish 就会报错；
		// `env` 在任何 shell 里都只是一个普通命令。
		expect(buildListDirectoryCommand("/srv", "gnu")).toContain("env LC_ALL=C");
	});
});

describe("stat 的格式串对精简系统同样有效", () => {
	const gnuCommands = [buildStatCommand("/srv/app", "gnu"), buildListDirectoryCommand("/srv/app", "gnu")];

	it("GNU 侧用 -c 而不是 --printf——busybox 的 stat 不认后者", () => {
		// 回归：远端是 Alpine 这类 busybox 系统时，`--printf` 报 unrecognized option，
		// 文件树全空、读写全报文件不存在。`-c` 两家都认。
		for (const command of gnuCommands) {
			expect(command).not.toContain("--printf");
			expect(command).toMatch(/stat(?: -L)? -c '/);
		}
	});

	it("字段分隔用真实制表符，而不是反斜杠 t——只有 --printf 会解释转义", () => {
		for (const command of [...gnuCommands, buildStatCommand("/srv/app", "bsd")]) {
			expect(command).toContain("\t");
			// 字面的反斜杠加 t 会被 -c 与 -f 原样输出，整行随即解析不出字段。
			expect(command).not.toContain("\\t");
		}
	});
});

describe("remote process token validation", () => {
	it("processToken 只能是文件名，不能借它写到别处", () => {
		expect(() => buildRemoteCommand("ls", { processToken: "../x" })).toThrow(/Invalid remote process token/);
		expect(() => buildKillCommand("a b")).toThrow(/Invalid remote process token/);
	});
});
