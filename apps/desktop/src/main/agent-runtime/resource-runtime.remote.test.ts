import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, posix } from "node:path";
import type { SessionResourceRuntime } from "@vetta/coding-agent/resources";
import { createLoopbackSshConnection, loopbackRemotePath } from "@vetta/ssh-transport/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const connection = createLoopbackSshConnection();
vi.mock("../ssh/ssh-runtime.js", () => ({ getSshConnection: () => connection }));

const { createDesktopPromptRuntimeSources } = await import("./resource-runtime.js");
const directories: string[] = [];
const pendingReloads = new Set<Promise<unknown>>();

function temporaryDirectory(parent: string, prefix: string): string {
	const directory = realpathSync(mkdtempSync(join(parent, prefix)));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	// A timed-out test still fails; finish only its owned I/O before deleting its fixture files.
	await Promise.allSettled([...pendingReloads]);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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

describe("远程项目会话的资源发现", () => {
	it("读到远端项目自己的 AGENTS.md 与项目技能，不读本机的", async () => {
		const reads = {
			stat: vi.spyOn(connection, "stat"),
			readText: vi.spyOn(connection, "readFile"),
			realPath: vi.spyOn(connection, "realPath"),
		};
		const { remotePath, agentDir } = resourceFixture();

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

describe("已加载的远程资源再次刷新", () => {
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
			await createDesktopPromptRuntimeSources({
				cwd: `ssh://build-01${fixture.remotePath}`,
				agentDir: fixture.agentDir,
				sessionOptions: { includeAgentSkills: true },
				runtimeSkillPaths: [],
			} as never)
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
		const loading = source.reload();
		pendingReloads.add(loading);
		try {
			await loading;
		} finally {
			pendingReloads.delete(loading);
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
