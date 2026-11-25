import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getVettaHomePath } from "@vetta/action-rpc";
import type { WorktreeRun, WorktreeRunStoreData } from "./worktree-run-types.js";

/**
 * 并行实验记录的持久化：一个 JSON 文件存全部 run。
 * run 是低频资源（用户手动创建），单文件全量读写足够；
 * 原子写入（临时文件 + rename）防止应用崩溃截断。
 */
export class WorktreeRunStore {
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly filePath = join(getVettaHomePath(), "worktree-runs", "runs.json")) {}

	async list(): Promise<readonly WorktreeRun[]> {
		return (await this.read()).runs;
	}

	async get(runId: string): Promise<WorktreeRun | undefined> {
		return (await this.read()).runs.find((run) => run.id === runId);
	}

	async upsert(run: WorktreeRun): Promise<void> {
		await this.mutate((data) => {
			const index = data.runs.findIndex((existing) => existing.id === run.id);
			const runs = [...data.runs];
			if (index >= 0) runs[index] = run;
			else runs.unshift(run);
			return { runs };
		});
	}

	async remove(runId: string): Promise<void> {
		await this.mutate((data) => ({ runs: data.runs.filter((run) => run.id !== runId) }));
	}

	private async read(): Promise<WorktreeRunStoreData> {
		try {
			const raw = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as WorktreeRunStoreData;
			return { runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
		} catch {
			return { runs: [] };
		}
	}

	/** 串行化写操作：run 状态更新来自并行的 lane 完成回调，不串行化会丢更新。 */
	private mutate(update: (data: WorktreeRunStoreData) => WorktreeRunStoreData): Promise<void> {
		const next = this.writeQueue.then(async () => {
			const data = update(await this.read());
			await mkdir(dirname(this.filePath), { recursive: true });
			const temporary = `${this.filePath}.tmp`;
			await writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
			await rename(temporary, this.filePath);
		});
		this.writeQueue = next.catch(() => undefined);
		return next;
	}
}
