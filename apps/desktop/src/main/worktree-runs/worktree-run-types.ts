/** 并行 worktree 编排的持久化记录与公开合同。 */

export type WorktreeLaneStatus = "pending" | "running" | "done" | "error" | "interrupted";
export type WorktreeRunStatus = "running" | "done" | "adopted" | "discarded";

export interface WorktreeLane {
	readonly index: number;
	readonly branch: string;
	readonly worktreePath: string;
	readonly status: WorktreeLaneStatus;
	readonly sessionId?: string;
	readonly sessionPath?: string;
	readonly error?: string;
	/** 完成后该 lane 相对 base 的 diffstat 摘要（`git diff --stat` 文本）。 */
	readonly diffStat?: string;
	readonly reply?: string;
}

export interface WorktreeRun {
	readonly id: string;
	readonly projectPath: string;
	readonly prompt: string;
	readonly baseCommit: string;
	readonly createdAt: number;
	readonly status: WorktreeRunStatus;
	readonly lanes: readonly WorktreeLane[];
	/** 采纳的 lane 序号；采纳后补丁应用于原项目工作区（未提交变更）。 */
	readonly adoptedLane?: number;
	readonly error?: string;
}

export interface WorktreeRunStoreData {
	readonly runs: readonly WorktreeRun[];
}
