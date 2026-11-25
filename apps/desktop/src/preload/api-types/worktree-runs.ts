/** 并行 worktree 实验的 preload 合同：与 main/worktree-runs 的持久化记录同构。 */

export type WorktreeLaneStatus = "pending" | "running" | "done" | "error" | "interrupted";
export type WorktreeRunStatus = "running" | "done" | "adopted" | "discarded";

export interface WorktreeLaneInfo {
	readonly index: number;
	readonly branch: string;
	readonly worktreePath: string;
	readonly status: WorktreeLaneStatus;
	readonly sessionId?: string;
	readonly sessionPath?: string;
	readonly error?: string;
	readonly diffStat?: string;
	readonly reply?: string;
}

export interface WorktreeRunInfo {
	readonly id: string;
	readonly projectPath: string;
	readonly prompt: string;
	readonly baseCommit: string;
	readonly createdAt: number;
	readonly status: WorktreeRunStatus;
	readonly lanes: readonly WorktreeLaneInfo[];
	readonly adoptedLane?: number;
	readonly error?: string;
}

export interface WorktreeLaneDiff {
	readonly diff: string;
	readonly files: readonly { status: string; path: string }[];
}

export interface DesktopWorktreeRunsApi {
	readonly list: () => Promise<readonly WorktreeRunInfo[]>;
	readonly get: (runId: string) => Promise<WorktreeRunInfo>;
	readonly create: (input: { projectPath: string; prompt: string; laneCount: number }) => Promise<WorktreeRunInfo>;
	readonly laneDiff: (runId: string, laneIndex: number) => Promise<WorktreeLaneDiff>;
	readonly adopt: (runId: string, laneIndex: number) => Promise<WorktreeRunInfo>;
	readonly discard: (runId: string) => Promise<WorktreeRunInfo>;
	readonly removeRecord: (runId: string) => Promise<void>;
}
