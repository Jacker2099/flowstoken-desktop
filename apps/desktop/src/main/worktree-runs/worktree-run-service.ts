import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getVettaHomePath } from "@vetta/action-rpc";
import { getDesktopConversationService } from "../conversations/desktop-conversation-service.js";
import { getAppLogger } from "../logger.js";
import { getSharedRuntime } from "../runtime.js";
import {
	addWorktree,
	applyPatchToProject,
	type GitRunner,
	laneChangedFiles,
	laneDiff,
	laneDiffStat,
	removeWorktree,
	resolveBaseCommit,
	systemGitRunner,
} from "./worktree-git.js";
import { WorktreeRunStore } from "./worktree-run-store.js";
import type { WorktreeLane, WorktreeRun } from "./worktree-run-types.js";

const log = getAppLogger("worktree-runs");
export const WORKTREE_RUN_MAX_LANES = 4;
export const WORKTREE_RUN_MIN_LANES = 2;

export interface WorktreeRunServiceDependencies {
	readonly store?: WorktreeRunStore;
	readonly git?: GitRunner;
	readonly conversations?: Pick<
		ReturnType<typeof getDesktopConversationService>,
		"createSession" | "promptInteractiveSession"
	>;
	readonly worktreeRoot?: string;
	readonly now?: () => number;
	/** lane 回复读取：生产走 shared runtime，测试注入假实现避免起 runtime。 */
	readonly readReply?: (sessionId: string) => string;
}

function laneBranch(runId: string, index: number): string {
	return `vetta-run/${runId}/lane-${index}`;
}

function lastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; body?: unknown; content?: unknown };
		if (message?.role !== "assistant") continue;
		if (typeof message.body === "string" && message.body.trim()) return message.body;
		if (typeof message.content === "string" && message.content.trim()) return message.content;
	}
	return "";
}

/**
 * 并行 worktree 编排：同一 prompt 扇出到 N 个独立 git worktree 的会话并行执行，
 * 完成后按 lane 对比 diff，用户采纳其一（补丁应用到原项目工作区）或整体丢弃。
 *
 * 资源所有权：lane 的 worktree 与分支全部由本服务创建/回收，原项目的 HEAD、
 * index、工作区在采纳前零接触。会话本身复用普通交互会话管线（用户可以在
 * 会话列表里看到并打开 lane 会话），编排只负责扇出、跟踪与收尾。
 */
export class WorktreeRunService {
	private readonly store: WorktreeRunStore;
	private readonly git: GitRunner;
	private readonly conversations: WorktreeRunServiceDependencies["conversations"];
	private readonly worktreeRoot: string;
	private readonly now: () => number;
	private readonly readReply?: (sessionId: string) => string;
	/** 运行中 run 的收尾任务：应用退出/重启时不重复启动，状态落盘由 lane 回调自己完成。 */
	private readonly executing = new Map<string, Promise<void>>();

	constructor(dependencies: WorktreeRunServiceDependencies = {}) {
		this.store = dependencies.store ?? new WorktreeRunStore();
		this.git = dependencies.git ?? systemGitRunner;
		this.conversations = dependencies.conversations;
		this.worktreeRoot = dependencies.worktreeRoot ?? join(getVettaHomePath(), "worktree-runs", "lanes");
		this.now = dependencies.now ?? Date.now;
		this.readReply = dependencies.readReply;
	}

	private getConversations() {
		return this.conversations ?? getDesktopConversationService();
	}

	async listRuns(): Promise<readonly WorktreeRun[]> {
		return this.store.list();
	}

	async getRun(runId: string): Promise<WorktreeRun> {
		const run = await this.store.get(runId);
		if (!run) throw new Error("并行实验不存在或已删除");
		return run;
	}

	/**
	 * 应用重启后的状态修复：上次进程退出时还在 running 的 lane 会话已随进程中断，
	 * 标记为 interrupted（worktree 保留，用户仍可看 diff/采纳或丢弃）。
	 */
	async reconcileAfterRestart(): Promise<void> {
		for (const run of await this.store.list()) {
			if (run.status !== "running") continue;
			const lanes = run.lanes.map((lane) =>
				lane.status === "running" || lane.status === "pending" ? { ...lane, status: "interrupted" as const } : lane,
			);
			const allSettled = lanes.every(
				(lane) => lane.status === "done" || lane.status === "error" || lane.status === "interrupted",
			);
			await this.store.upsert({ ...run, lanes, status: allSettled ? "done" : run.status });
		}
	}

	async createRun(input: { projectPath: string; prompt: string; laneCount: number }): Promise<WorktreeRun> {
		const prompt = input.prompt.trim();
		if (!prompt) throw new Error("请输入要并行实验的 prompt");
		if (
			!Number.isInteger(input.laneCount) ||
			input.laneCount < WORKTREE_RUN_MIN_LANES ||
			input.laneCount > WORKTREE_RUN_MAX_LANES
		) {
			throw new Error(`并行数量须在 ${WORKTREE_RUN_MIN_LANES}～${WORKTREE_RUN_MAX_LANES} 之间`);
		}
		const baseCommit = await resolveBaseCommit(input.projectPath, this.git);
		const runId = randomUUID().slice(0, 8);
		const lanes: WorktreeLane[] = [];
		for (let index = 0; index < input.laneCount; index += 1) {
			lanes.push({
				index,
				branch: laneBranch(runId, index),
				worktreePath: join(this.worktreeRoot, runId, `lane-${index}`),
				status: "pending",
			});
		}
		let run: WorktreeRun = {
			id: runId,
			projectPath: input.projectPath,
			prompt,
			baseCommit,
			createdAt: this.now(),
			status: "running",
			lanes,
		};
		await this.store.upsert(run);

		try {
			for (const lane of lanes) {
				await addWorktree(input.projectPath, lane.worktreePath, lane.branch, baseCommit, this.git);
			}
		} catch (error) {
			// 建到一半失败：已建的 worktree 全部回收，run 直接标 error，不留半初始化资源。
			for (const lane of lanes) {
				await removeWorktree(input.projectPath, lane.worktreePath, lane.branch, this.git);
			}
			run = { ...run, status: "done", error: error instanceof Error ? error.message : String(error) };
			await this.store.upsert(run);
			throw error;
		}

		const execution = this.executeLanes(run).catch((error) =>
			log.warn("[worktree-runs] lane execution failed", error),
		);
		this.executing.set(runId, execution);
		void execution.finally(() => this.executing.delete(runId));
		return this.getRun(runId);
	}

	/** 扇出执行：每个 lane 建会话、发 prompt、等轮次完成，全部 settle 后汇总 diffstat。 */
	private async executeLanes(run: WorktreeRun): Promise<void> {
		await Promise.all(run.lanes.map((lane) => this.executeLane(run, lane)));
		const latest = await this.store.get(run.id);
		if (!latest || latest.status !== "running") return;
		for (const lane of latest.lanes) {
			if (lane.status !== "done") continue;
			try {
				const diffStat = await laneDiffStat(lane.worktreePath, latest.baseCommit, this.git);
				await this.patchLane(latest.id, lane.index, { diffStat: diffStat || "（无改动）" });
			} catch (error) {
				log.warn("[worktree-runs] diffstat failed", { run: latest.id, lane: lane.index, error });
			}
		}
		const settled = await this.store.get(run.id);
		if (settled && settled.status === "running") {
			await this.store.upsert({ ...settled, status: "done" });
		}
	}

	private async executeLane(run: WorktreeRun, lane: WorktreeLane): Promise<void> {
		await this.patchLane(run.id, lane.index, { status: "running" });
		try {
			const conversations = this.getConversations();
			const session = await conversations.createSession({ cwd: lane.worktreePath }, "conversation", "interactive");
			await this.patchLane(run.id, lane.index, {
				sessionId: session.sessionId,
				sessionPath: session.sessionPath,
			});
			const outcome = await conversations.promptInteractiveSession(
				session.sessionId,
				{ text: run.prompt },
				lane.worktreePath,
			);
			const reply = this.readReply
				? this.readReply(session.sessionId)
				: lastAssistantText(getSharedRuntime().getMessages(session.sessionId));
			const succeeded = outcome.status === "completed" || outcome.status === "handled";
			await this.patchLane(run.id, lane.index, {
				status: succeeded ? "done" : "error",
				reply: reply.slice(0, 2000),
				...(succeeded ? {} : { error: `轮次未成功完成：${outcome.status}` }),
			});
		} catch (error) {
			await this.patchLane(run.id, lane.index, {
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** lane 补丁的按 run 互斥链：并行 lane 同时回调时 read-modify-write 必须串行，否则后写覆盖先写丢状态。 */
	private readonly lanePatchChains = new Map<string, Promise<void>>();

	/** lane 字段补丁：读-改-写整条 run；store 只串行写本身，读改写竞争由这里的互斥链收口。 */
	private patchLane(runId: string, laneIndex: number, patch: Partial<WorktreeLane>): Promise<void> {
		const previous = this.lanePatchChains.get(runId) ?? Promise.resolve();
		const next = previous.then(async () => {
			const run = await this.store.get(runId);
			if (!run) return;
			const lanes = run.lanes.map((lane) => (lane.index === laneIndex ? { ...lane, ...patch } : lane));
			await this.store.upsert({ ...run, lanes });
		});
		this.lanePatchChains.set(
			runId,
			next.catch(() => undefined),
		);
		return next;
	}

	/** 单个 lane 的完整 diff（补丁文本），供 UI 展开查看。 */
	async readLaneDiff(
		runId: string,
		laneIndex: number,
	): Promise<{ diff: string; files: readonly { status: string; path: string }[] }> {
		const run = await this.getRun(runId);
		const lane = run.lanes.find((entry) => entry.index === laneIndex);
		if (!lane) throw new Error("lane 不存在");
		// 两个操作都要先 add -A，同一 worktree 的 index 锁不允许并发，顺序执行（add 幂等）。
		const diff = await laneDiff(lane.worktreePath, run.baseCommit, this.git);
		const files = await laneChangedFiles(lane.worktreePath, run.baseCommit, this.git);
		return { diff, files };
	}

	/**
	 * 采纳 lane：补丁应用到原项目工作区（未提交改动），随后回收全部 lane 资源。
	 * 应用失败时不做任何清理——worktree 还在，用户可以处理冲突后重试。
	 */
	async adoptLane(runId: string, laneIndex: number): Promise<WorktreeRun> {
		const run = await this.getRun(runId);
		if (run.status === "adopted") throw new Error("该实验已采纳过");
		if (run.status === "discarded") throw new Error("该实验已丢弃");
		const lane = run.lanes.find((entry) => entry.index === laneIndex);
		if (!lane) throw new Error("lane 不存在");
		const patch = await laneDiff(lane.worktreePath, run.baseCommit, this.git);
		await applyPatchToProject(run.projectPath, patch, this.git);
		await this.cleanupLanes(run);
		const adopted: WorktreeRun = { ...run, status: "adopted", adoptedLane: laneIndex };
		await this.store.upsert(adopted);
		return adopted;
	}

	/** 丢弃实验：回收全部 lane 资源，原项目自始至终未被触碰。 */
	async discardRun(runId: string): Promise<WorktreeRun> {
		const run = await this.getRun(runId);
		if (run.status === "running" && this.executing.has(runId)) {
			throw new Error("实验仍在运行，等完成后再丢弃（lane 会话可直接在会话列表中停止）");
		}
		await this.cleanupLanes(run);
		const discarded: WorktreeRun = { ...run, status: "discarded" };
		await this.store.upsert(discarded);
		return discarded;
	}

	/** 删除记录：仅对已收尾（adopted/discarded）的 run 清理历史条目。 */
	async removeRunRecord(runId: string): Promise<void> {
		const run = await this.getRun(runId);
		if (run.status === "running") throw new Error("运行中的实验不能删除记录");
		await this.store.remove(runId);
	}

	private async cleanupLanes(run: WorktreeRun): Promise<void> {
		for (const lane of run.lanes) {
			await removeWorktree(run.projectPath, lane.worktreePath, lane.branch, this.git);
		}
	}
}

let shared: WorktreeRunService | null = null;

export function getWorktreeRunService(): WorktreeRunService {
	if (!shared) shared = new WorktreeRunService();
	return shared;
}
