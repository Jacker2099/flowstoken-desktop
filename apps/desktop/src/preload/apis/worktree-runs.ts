import type { IpcRenderer } from "electron";
import type { DesktopApi } from "../api.js";

export function createWorktreeRunsApi(ipc: IpcRenderer): Pick<DesktopApi, "worktreeRuns"> {
	return {
		worktreeRuns: {
			list: () => ipc.invoke("vetta:worktree-runs:list"),
			get: (runId) => ipc.invoke("vetta:worktree-runs:get", runId),
			create: (input) => ipc.invoke("vetta:worktree-runs:create", input),
			laneDiff: (runId, laneIndex) => ipc.invoke("vetta:worktree-runs:lane-diff", runId, laneIndex),
			adopt: (runId, laneIndex) => ipc.invoke("vetta:worktree-runs:adopt", runId, laneIndex),
			discard: (runId) => ipc.invoke("vetta:worktree-runs:discard", runId),
			removeRecord: (runId) => ipc.invoke("vetta:worktree-runs:remove-record", runId),
		},
	};
}
