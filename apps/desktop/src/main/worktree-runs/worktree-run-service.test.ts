import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../conversations/desktop-conversation-service.js", () => ({
	getDesktopConversationService: () => {
		throw new Error("tests must inject conversations");
	},
}));
vi.mock("../runtime.js", () => ({
	getSharedRuntime: () => {
		throw new Error("tests must inject readReply");
	},
}));
vi.mock("../logger.js", () => ({
	getAppLogger: () => () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import { WorktreeRunService } from "./worktree-run-service.js";
import { WorktreeRunStore } from "./worktree-run-store.js";

/**
 * 端到端行为测试：真实 git 仓库 + 真实 worktree/diff/apply，
 * 只有会话执行是注入的假实现（不起 runtime）。
 */
function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vetta-wt-project-"));
	git(["init", "-b", "main"], dir);
	git(["config", "user.email", "test@test.local"], dir);
	git(["config", "user.name", "test"], dir);
	await writeFile(join(dir, "app.ts"), "export const version = 1;\n", "utf8");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return dir;
}

describe("WorktreeRunService", () => {
	let project: string;
	let root: string;
	let service: WorktreeRunService;
	let promptCount: number;
	const cleanups: string[] = [];

	beforeEach(async () => {
		project = await createProject();
		root = await mkdtemp(join(tmpdir(), "vetta-wt-root-"));
		cleanups.push(project, root);
		promptCount = 0;
		const conversations = {
			createSession: vi.fn(async (config: { cwd?: string }) => ({
				sessionId: `sess-${config.cwd}`,
				sessionPath: `${config.cwd}/session.jsonl`,
			})) as never,
			promptInteractiveSession: vi.fn(async (sessionId: string): Promise<{ status: "completed" }> => {
				promptCount += 1;
				// 模拟 agent 在 lane 里改了文件：lane 之间内容不同，便于区分。
				const lanePath = sessionId.replace(/^sess-/, "");
				await writeFile(join(lanePath, "app.ts"), `export const version = 2; // ${lanePath}\n`, "utf8");
				await writeFile(join(lanePath, "new-file.ts"), `export const lane = "${lanePath}";\n`, "utf8");
				return { status: "completed" as const };
			}),
		};
		service = new WorktreeRunService({
			store: new WorktreeRunStore(join(root, "runs.json")),
			worktreeRoot: join(root, "lanes"),
			conversations,
			readReply: () => "完成",
		});
	});

	afterEach(async () => {
		for (const dir of cleanups.splice(0)) {
			// worktree 注册在仓库里，先清 worktree 注册再删目录，避免污染后续测试。
			try {
				git(["worktree", "prune"], project);
			} catch {
				/* 项目目录可能已经没了 */
			}
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	async function waitRunDone(runId: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const run = await service.getRun(runId);
			if (run.status !== "running") return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error("run did not settle in time");
	}

	it("fans out the prompt to isolated worktrees and records per-lane results", async () => {
		const run = await service.createRun({ projectPath: project, prompt: "升级版本", laneCount: 2 });
		await waitRunDone(run.id);

		const settled = await service.getRun(run.id);
		expect(settled.status).toBe("done");
		expect(settled.lanes).toHaveLength(2);
		expect(promptCount).toBe(2);
		for (const lane of settled.lanes) {
			expect(lane.status).toBe("done");
			expect(lane.reply).toBe("完成");
			expect(lane.diffStat).toContain("app.ts");
		}
		// lane 的改动不进入原项目工作区
		expect(await readFile(join(project, "app.ts"), "utf8")).toBe("export const version = 1;\n");
	});

	it("adopting a lane applies its patch to the project worktree and cleans up all lanes", async () => {
		const run = await service.createRun({ projectPath: project, prompt: "升级版本", laneCount: 2 });
		await waitRunDone(run.id);

		const adopted = await service.adoptLane(run.id, 1);
		expect(adopted.status).toBe("adopted");
		expect(adopted.adoptedLane).toBe(1);

		// 原项目工作区出现 lane-1 的改动（未提交）
		const content = await readFile(join(project, "app.ts"), "utf8");
		expect(content).toContain("version = 2");
		expect(content).toContain("lane-1");
		const newFile = await readFile(join(project, "new-file.ts"), "utf8");
		expect(newFile).toContain("lane-1");
		// 未提交状态
		expect(git(["status", "--porcelain"], project)).toContain("app.ts");
		// lane 资源全部回收
		expect(git(["worktree", "list", "--porcelain"], project)).not.toContain("lane-0");
		expect(git(["branch", "--list", "vetta-run/*"], project).trim()).toBe("");
	});

	it("discarding a run leaves the project untouched and cleans up lanes", async () => {
		const run = await service.createRun({ projectPath: project, prompt: "升级版本", laneCount: 3 });
		await waitRunDone(run.id);

		const discarded = await service.discardRun(run.id);
		expect(discarded.status).toBe("discarded");
		expect(await readFile(join(project, "app.ts"), "utf8")).toBe("export const version = 1;\n");
		expect(git(["worktree", "list", "--porcelain"], project)).not.toContain("lane-");
	});

	it("readLaneDiff exposes per-file changes for comparison", async () => {
		const run = await service.createRun({ projectPath: project, prompt: "升级版本", laneCount: 2 });
		await waitRunDone(run.id);

		const { diff, files } = await service.readLaneDiff(run.id, 0);
		expect(files.map((file) => file.path).sort()).toEqual(["app.ts", "new-file.ts"]);
		expect(diff).toContain("version = 2");
		expect(diff).toContain("new-file.ts");
	});

	it("rejects non-git projects and repos without commits", async () => {
		const plain = await mkdtemp(join(tmpdir(), "vetta-wt-plain-"));
		cleanups.push(plain);
		await expect(service.createRun({ projectPath: plain, prompt: "x", laneCount: 2 })).rejects.toThrow(
			"不是 git 仓库",
		);

		const empty = await mkdtemp(join(tmpdir(), "vetta-wt-empty-"));
		cleanups.push(empty);
		git(["init", "-b", "main"], empty);
		await expect(service.createRun({ projectPath: empty, prompt: "x", laneCount: 2 })).rejects.toThrow("初始提交");
	});

	it("marks lanes interrupted when reconciling a running run after restart", async () => {
		const store = new WorktreeRunStore(join(root, "runs.json"));
		await store.upsert({
			id: "stale",
			projectPath: project,
			prompt: "x",
			baseCommit: "abc",
			createdAt: Date.now(),
			status: "running",
			lanes: [{ index: 0, branch: "b", worktreePath: "/tmp/x", status: "running" }],
		});
		await service.reconcileAfterRestart();
		const run = await service.getRun("stale");
		expect(run.lanes[0]?.status).toBe("interrupted");
		expect(run.status).toBe("done");
	});
});
