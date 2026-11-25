import { ipcMain } from "electron";
import { getWorktreeRunService } from "../worktree-runs/worktree-run-service.js";

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function requireLaneIndex(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error("laneIndex must be a non-negative integer");
	return value;
}

/** 并行 worktree 实验的 IPC 薄桥：参数形状校验后直接转交编排服务。 */
export function registerWorktreeRunsIpc(): () => void {
	const service = () => getWorktreeRunService();

	ipcMain.handle("vetta:worktree-runs:list", () => service().listRuns());
	ipcMain.handle("vetta:worktree-runs:get", (_event, runId: unknown) =>
		service().getRun(requireString(runId, "runId")),
	);
	ipcMain.handle("vetta:worktree-runs:create", (_event, input: unknown) => {
		const record = (input ?? {}) as Record<string, unknown>;
		return service().createRun({
			projectPath: requireString(record.projectPath, "projectPath"),
			prompt: requireString(record.prompt, "prompt"),
			laneCount: requireLaneIndex(record.laneCount),
		});
	});
	ipcMain.handle("vetta:worktree-runs:lane-diff", (_event, runId: unknown, laneIndex: unknown) =>
		service().readLaneDiff(requireString(runId, "runId"), requireLaneIndex(laneIndex)),
	);
	ipcMain.handle("vetta:worktree-runs:adopt", (_event, runId: unknown, laneIndex: unknown) =>
		service().adoptLane(requireString(runId, "runId"), requireLaneIndex(laneIndex)),
	);
	ipcMain.handle("vetta:worktree-runs:discard", (_event, runId: unknown) =>
		service().discardRun(requireString(runId, "runId")),
	);
	ipcMain.handle("vetta:worktree-runs:remove-record", (_event, runId: unknown) =>
		service().removeRunRecord(requireString(runId, "runId")),
	);

	return () => {
		for (const channel of [
			"vetta:worktree-runs:list",
			"vetta:worktree-runs:get",
			"vetta:worktree-runs:create",
			"vetta:worktree-runs:lane-diff",
			"vetta:worktree-runs:adopt",
			"vetta:worktree-runs:discard",
			"vetta:worktree-runs:remove-record",
		]) {
			ipcMain.removeHandler(channel);
		}
	};
}
