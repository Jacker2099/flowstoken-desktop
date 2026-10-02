import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, posix } from "node:path";
import { createLoopbackSshConnection, loopbackRemotePath } from "@vetta/ssh-transport/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const connection = createLoopbackSshConnection();
vi.mock("../ssh/ssh-runtime.js", () => ({ getSshConnection: () => connection }));

const { createDesktopPromptRuntimeSources } = await import("./resource-runtime.js");
const directories: string[] = [];

function temporaryDirectory(parent: string, prefix: string): string {
	const directory = realpathSync(mkdtempSync(join(parent, prefix)));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

beforeAll(async () => {
	// Establish the loopback SSH fixture before measuring resource discovery.
	await connection.probePlatform();
});

describe("远程项目会话的资源发现", () => {
	it("读到远端项目自己的 AGENTS.md 与项目技能，不读本机的", async () => {
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

		const { resourceSource } = await createDesktopPromptRuntimeSources({
			cwd: `ssh://build-01${remotePath}`,
			agentDir,
			sessionOptions: { includeAgentSkills: true },
			runtimeSkillPaths: [],
		} as never);

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
	});
});
