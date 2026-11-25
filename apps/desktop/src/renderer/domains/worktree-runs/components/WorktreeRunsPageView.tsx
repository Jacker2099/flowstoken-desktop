import type { WorktreeLaneDiff, WorktreeLaneInfo, WorktreeRunInfo } from "@preload/api-types/worktree-runs.js";
import { Button } from "@shared/components/ui/button";
import type { WorktreeRunsModel } from "./useWorktreeRunsModel";

function laneStatusColor(status: WorktreeLaneInfo["status"]): string {
	switch (status) {
		case "done":
			return "text-green-600 dark:text-green-400";
		case "error":
		case "interrupted":
			return "text-red-500";
		case "running":
			return "text-blue-500";
		default:
			return "text-muted-foreground";
	}
}

function DiffBlock({ value }: { value: WorktreeLaneDiff | "loading" | "error" }) {
	if (value === "loading") return <div className="px-3 py-2 text-xs text-muted-foreground">…</div>;
	if (value === "error") return <div className="px-3 py-2 text-xs text-red-500">diff load failed</div>;
	if (!value.diff.trim()) return <div className="px-3 py-2 text-xs text-muted-foreground">—</div>;
	return (
		<pre className="max-h-80 overflow-auto rounded-lg bg-foreground/[0.04] p-3 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all">
			{value.diff.slice(0, 20000)}
			{value.diff.length > 20000 ? "\n… (truncated)" : ""}
		</pre>
	);
}

function LaneCard({
	run,
	lane,
	model,
}: {
	readonly run: WorktreeRunInfo;
	readonly lane: WorktreeLaneInfo;
	readonly model: WorktreeRunsModel;
}) {
	const { labels } = model;
	const key = `${run.id}:${lane.index}`;
	const diffValue = model.expandedDiff[key];
	const busy = model.actingRun === run.id;
	const adoptable = run.status === "done" && lane.status === "done";
	return (
		<div className="rounded-xl border border-border/60 p-3">
			<div className="flex items-center gap-2">
				<span className="text-[13px] font-medium">{labels.laneTitle(lane.index)}</span>
				<span className={`text-xs ${laneStatusColor(lane.status)}`}>{labels.laneStatus[lane.status] ?? lane.status}</span>
				{run.adoptedLane === lane.index && <span className="text-xs text-green-600">{labels.adoptedLabel}</span>}
				<div className="flex-1" />
				{(lane.status === "done" || lane.status === "interrupted" || lane.status === "error") && (
					<Button variant="ghost" size="sm" onClick={() => void model.actions.toggleDiff(run.id, lane.index)}>
						{diffValue ? labels.hideDiff : labels.viewDiff}
					</Button>
				)}
				{adoptable && (
					<Button variant="outline" size="sm" disabled={busy} onClick={() => void model.actions.adopt(run.id, lane.index)}>
						{busy ? labels.adopting : labels.adopt}
					</Button>
				)}
			</div>
			{lane.diffStat && (
				<pre className="mt-2 font-mono text-[11px] leading-4 text-muted-foreground whitespace-pre-wrap">{lane.diffStat}</pre>
			)}
			{lane.error && <div className="mt-2 text-xs text-red-500">{lane.error}</div>}
			{lane.reply && (
				<div className="mt-2 rounded-lg bg-foreground/[0.03] px-3 py-2 text-xs leading-5 text-muted-foreground">
					<span className="font-medium">{labels.reply}: </span>
					{lane.reply.slice(0, 500)}
				</div>
			)}
			{diffValue && diffValue !== "loading" && (
				<div className="mt-2">
					<DiffBlock value={diffValue} />
				</div>
			)}
			{diffValue === "loading" && <DiffBlock value="loading" />}
		</div>
	);
}

function RunCard({ run, model }: { readonly run: WorktreeRunInfo; readonly model: WorktreeRunsModel }) {
	const { labels } = model;
	const busy = model.actingRun === run.id;
	const createdAt = new Date(run.createdAt).toLocaleString();
	return (
		<section className="rounded-2xl border border-border/60 bg-background p-4">
			<header className="flex items-center gap-2">
				<span className="rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground">
					{labels.statusLabels[run.status] ?? run.status}
				</span>
				<span className="text-xs text-muted-foreground">{createdAt}</span>
				<span className="max-w-40 truncate font-mono text-[11px] text-muted-foreground" title={run.projectPath}>
					{run.projectPath}
				</span>
				<div className="flex-1" />
				{(run.status === "done" || run.status === "running") && (
					<Button variant="ghost" size="sm" disabled={busy} onClick={() => void model.actions.discard(run.id)}>
						{busy ? labels.discarding : labels.discard}
					</Button>
				)}
				{(run.status === "adopted" || run.status === "discarded") && (
					<Button variant="ghost" size="sm" onClick={() => void model.actions.removeRecord(run.id)}>
						{labels.removeRecord}
					</Button>
				)}
			</header>
			<p className="mt-2 text-[13px] leading-5 whitespace-pre-wrap">{run.prompt}</p>
			{run.error && <div className="mt-2 text-xs text-red-500">{run.error}</div>}
			<div className="mt-3 grid gap-3 lg:grid-cols-2">
				{run.lanes.map((lane) => (
					<LaneCard key={lane.index} run={run} lane={lane} model={model} />
				))}
			</div>
		</section>
	);
}

export function WorktreeRunsPageView({ model }: { readonly model: WorktreeRunsModel }) {
	const { labels, form } = model;
	return (
		<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto px-6 py-5">
			<header>
				<h1 className="text-lg font-semibold">{labels.title}</h1>
				<p className="mt-1 text-xs text-muted-foreground">{labels.subtitle}</p>
			</header>

			<section className="rounded-2xl border border-border/60 bg-background p-4">
				<h2 className="text-[13px] font-medium">{labels.createTitle}</h2>
				<div className="mt-3 flex flex-col gap-3">
					<label className="flex items-center gap-3 text-xs">
						<span className="w-16 shrink-0 text-muted-foreground">{labels.project}</span>
						<select
							className="h-8 flex-1 rounded-lg border border-border/60 bg-transparent px-2 text-[13px]"
							value={form.projectPath}
							onChange={(event) => form.setProjectPath(event.target.value)}
						>
							{model.projects.length === 0 && <option value="">{labels.projectPlaceholder}</option>}
							{model.projects.map((project) => (
								<option key={project.path} value={project.path}>
									{project.name ?? project.path}
								</option>
							))}
						</select>
						<span className="w-16 shrink-0 text-muted-foreground">{labels.lanes}</span>
						<select
							className="h-8 w-20 rounded-lg border border-border/60 bg-transparent px-2 text-[13px]"
							value={form.laneCount}
							onChange={(event) => form.setLaneCount(Number(event.target.value))}
						>
							{[2, 3, 4].map((count) => (
								<option key={count} value={count}>
									{count}
									{labels.lanesUnit}
								</option>
							))}
						</select>
					</label>
					<textarea
						className="min-h-20 rounded-lg border border-border/60 bg-transparent px-3 py-2 text-[13px] leading-5 outline-none focus:border-foreground/30"
						placeholder={labels.promptPlaceholder}
						value={form.prompt}
						onChange={(event) => form.setPrompt(event.target.value)}
					/>
					<div className="flex items-center gap-3">
						<Button
							size="sm"
							disabled={model.creating || !form.prompt.trim() || !form.projectPath}
							onClick={() => void model.actions.create()}
						>
							{model.creating ? labels.creating : labels.submit}
						</Button>
						{model.error && <span className="text-xs text-red-500">{model.error}</span>}
						<div className="flex-1" />
						<Button variant="ghost" size="sm" onClick={() => void model.actions.refresh()}>
							{labels.refresh}
						</Button>
					</div>
				</div>
			</section>

			{model.runs.length === 0 && !model.loading && (
				<section className="rounded-2xl border border-dashed border-border/60 p-8 text-center">
					<p className="text-[13px] font-medium">{labels.empty}</p>
					<p className="mt-1 text-xs text-muted-foreground">{labels.emptyHint}</p>
				</section>
			)}
			{model.runs.map((run) => (
				<RunCard key={run.id} run={run} model={model} />
			))}
		</div>
	);
}
