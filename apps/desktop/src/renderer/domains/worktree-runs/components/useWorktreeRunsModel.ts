import type { WorktreeLaneDiff, WorktreeRunInfo } from "@preload/api-types/worktree-runs.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface WorktreeRunsViewLabels {
	readonly title: string;
	readonly subtitle: string;
	readonly createTitle: string;
	readonly project: string;
	readonly projectPlaceholder: string;
	readonly prompt: string;
	readonly promptPlaceholder: string;
	readonly lanes: string;
	readonly lanesUnit: string;
	readonly submit: string;
	readonly creating: string;
	readonly empty: string;
	readonly emptyHint: string;
	readonly refresh: string;
	readonly discard: string;
	readonly discarding: string;
	readonly removeRecord: string;
	readonly confirmDiscard: string;
	readonly confirmAdopt: string;
	readonly laneTitle: (index: number) => string;
	readonly laneStatus: Record<string, string>;
	readonly noChanges: string;
	readonly viewDiff: string;
	readonly hideDiff: string;
	readonly adopt: string;
	readonly adopting: string;
	readonly adoptedLabel: string;
	readonly reply: string;
	readonly statusLabels: Record<string, string>;
}

const RUNNING_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;

/** 连接层 model：拉取 run 列表、创建/采纳/丢弃动作、按运行状态自适应轮询。 */
export function useWorktreeRunsModel() {
	const { t } = useTranslation("worktree-runs");
	const [runs, setRuns] = useState<readonly WorktreeRunInfo[]>([]);
	const [projects, setProjects] = useState<readonly { path: string; name?: string }[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [actingRun, setActingRun] = useState<string | null>(null);
	const [expandedDiff, setExpandedDiff] = useState<Record<string, WorktreeLaneDiff | "loading" | "error">>({});
	const [projectPath, setProjectPath] = useState("");
	const [prompt, setPrompt] = useState("");
	const [laneCount, setLaneCount] = useState(2);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		try {
			const list = await window.vetta.worktreeRuns.list();
			setRuns(list);
			setError(null);
		} catch {
			setError(t("errors.loadFailed"));
		}
	}, [t]);

	useEffect(() => {
		void window.vetta.config.get().then((config) => {
			const entries = (config.projects ?? []).map((project) => ({ path: project.path, name: project.name }));
			setProjects(entries);
			if (entries.length > 0) setProjectPath((current) => current || entries[0]?.path || "");
		});
		void refresh().finally(() => setLoading(false));
	}, [refresh]);

	// 有 running 的 run 时 3s 轮询，全部收尾后降为 15s 心跳（用户在另一窗口操作也能跟上）。
	useEffect(() => {
		const hasRunning = runs.some((run) => run.status === "running");
		const delay = hasRunning ? RUNNING_POLL_MS : IDLE_POLL_MS;
		timerRef.current = setTimeout(() => void refresh(), delay);
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [runs, refresh]);

	const create = useCallback(async () => {
		setCreating(true);
		setError(null);
		try {
			await window.vetta.worktreeRuns.create({ projectPath, prompt, laneCount });
			setPrompt("");
			await refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("errors.createFailed"));
		} finally {
			setCreating(false);
		}
	}, [projectPath, prompt, laneCount, refresh, t]);

	const adopt = useCallback(
		async (runId: string, laneIndex: number) => {
			if (!window.confirm(t("actions.confirmAdopt"))) return;
			setActingRun(runId);
			setError(null);
			try {
				await window.vetta.worktreeRuns.adopt(runId, laneIndex);
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : t("errors.adoptFailed"));
			} finally {
				setActingRun(null);
			}
		},
		[refresh, t],
	);

	const discard = useCallback(
		async (runId: string) => {
			if (!window.confirm(t("actions.confirmDiscard"))) return;
			setActingRun(runId);
			setError(null);
			try {
				await window.vetta.worktreeRuns.discard(runId);
				await refresh();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : t("errors.discardFailed"));
			} finally {
				setActingRun(null);
			}
		},
		[refresh, t],
	);

	const removeRecord = useCallback(
		async (runId: string) => {
			await window.vetta.worktreeRuns.removeRecord(runId);
			await refresh();
		},
		[refresh],
	);

	const toggleDiff = useCallback(
		async (runId: string, laneIndex: number) => {
			const key = `${runId}:${laneIndex}`;
			if (expandedDiff[key] && expandedDiff[key] !== "loading") {
				setExpandedDiff((current) => {
					const next = { ...current };
					delete next[key];
					return next;
				});
				return;
			}
			setExpandedDiff((current) => ({ ...current, [key]: "loading" }));
			try {
				const diff = await window.vetta.worktreeRuns.laneDiff(runId, laneIndex);
				setExpandedDiff((current) => ({ ...current, [key]: diff }));
			} catch {
				setExpandedDiff((current) => ({ ...current, [key]: "error" }));
			}
		},
		[expandedDiff],
	);

	const labels = useMemo<WorktreeRunsViewLabels>(
		() => ({
			title: t("page.title"),
			subtitle: t("page.subtitle"),
			createTitle: t("create.title"),
			project: t("create.project"),
			projectPlaceholder: t("create.projectPlaceholder"),
			prompt: t("create.prompt"),
			promptPlaceholder: t("create.promptPlaceholder"),
			lanes: t("create.lanes"),
			lanesUnit: t("create.lanesUnit"),
			submit: t("create.submit"),
			creating: t("create.creating"),
			empty: t("list.empty"),
			emptyHint: t("list.emptyHint"),
			refresh: t("actions.refresh"),
			discard: t("actions.discard"),
			discarding: t("actions.discarding"),
			removeRecord: t("actions.removeRecord"),
			confirmDiscard: t("actions.confirmDiscard"),
			confirmAdopt: t("actions.confirmAdopt"),
			laneTitle: (index) => t("lane.title", { index: index + 1 }),
			laneStatus: {
				pending: t("lane.pending"),
				running: t("lane.running"),
				done: t("lane.done"),
				error: t("lane.error"),
				interrupted: t("lane.interrupted"),
			},
			noChanges: t("lane.noChanges"),
			viewDiff: t("lane.viewDiff"),
			hideDiff: t("lane.hideDiff"),
			adopt: t("lane.adopt"),
			adopting: t("lane.adopting"),
			adoptedLabel: t("lane.adopted"),
			reply: t("lane.reply"),
			statusLabels: {
				running: t("list.running"),
				done: t("list.done"),
				adopted: t("list.adopted"),
				discarded: t("list.discarded"),
			},
		}),
		[t],
	);

	return {
		labels,
		runs,
		projects,
		loading,
		error,
		creating,
		actingRun,
		expandedDiff,
		form: { projectPath, prompt, laneCount, setProjectPath, setPrompt, setLaneCount },
		actions: { create, adopt, discard, removeRecord, toggleDiff, refresh },
	};
}

export type WorktreeRunsModel = ReturnType<typeof useWorktreeRunsModel>;
