import type { FlowstokenCatalog, FlowstokenCatalogGroup, FlowstokenCatalogModel } from "@preload/api";
import { i18n } from "@shared/i18n";
import { getDefaultStore } from "jotai";
import { canonicalFlowstokenProviderId } from "../../../shared/flowstoken-catalog-policy";
import {
	applyFlowstokenCatalogSnapshotAtom,
	flowstokenCatalogVersionAtom,
	localModelsConfigVersionAtom,
} from "./model-catalog-atoms";

const TTL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
let generation = 0;
let latestTask: { generation: number; promise: Promise<void> } | null = null;
let modelEvents = 0;

export function notifyFlowstokenModelsChanged(): void {
	++modelEvents;
}

export function isFlowstokenCatalogRefreshing(): boolean {
	return inflight !== null;
}

export function invalidateFlowstokenCatalog(): void {
	++generation;
	loadedAt = 0;
	inflight = null;
	latestTask = null;
}

/**
 * 从主进程取整份服务器下发的模型目录（分组、厂商、顺序、显示名、NEW 窗口都在里面）。
 * TTL 内复用上次结果；取不到（未登录、离线、非 FlowsToken 构建）时保持原值，
 * 选择器退回 providers 自带的原始列表。
 */
export function revalidateFlowstokenCatalog(
	now: number = Date.now(),
	options: { force?: boolean } = {},
): Promise<void> {
	const observe = (task: Promise<void>) => (options.force ? task : task.catch(() => {}));
	if (inflight) return observe(inflight);
	if (!options.force && loadedAt && now - loadedAt < TTL_MS) return Promise.resolve();
	const getCatalog = window.vetta?.flowstoken?.getCatalog;
	const getSnapshot = window.vetta?.flowstoken?.getCatalogSnapshot;
	if (!getSnapshot && !getCatalog) return Promise.resolve();
	const current = generation;
	const store = getDefaultStore();
	const followLatest = (): Promise<void> =>
		latestTask?.generation === generation ? latestTask.promise : revalidateFlowstokenCatalog(Date.now(), options);
	const task = (async () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const eventsBeforeRead = modelEvents;
			const modelsVersion = store.get(localModelsConfigVersionAtom);
			const catalogVersion = store.get(flowstokenCatalogVersionAtom);
			// Production reads the reconciled pair in one main-process mutation queue.
			// The older preload/fixture path still needs guards across both IPC replies.
			const snapshot = getSnapshot
				? await getSnapshot(options)
				: { catalog: await getCatalog(options), config: await window.vetta.models.get() };
			// Keep a force caller attached to the replacement read, even when its
			// original IPC was superseded by an authoritative account event.
			if (current !== generation) return followLatest();
			if (eventsBeforeRead !== modelEvents) {
				// A queued BYOK save can emit the same event as reconciliation after
				// the paired read. Verify it without applying an unpaired config.
				const eventsBeforeCheck = modelEvents;
				const config = await window.vetta.models.get();
				if (current !== generation) return followLatest();
				if (eventsBeforeCheck !== modelEvents || JSON.stringify(config) !== JSON.stringify(snapshot.config))
					continue;
			}
			if (
				modelsVersion !== store.get(localModelsConfigVersionAtom) ||
				catalogVersion !== store.get(flowstokenCatalogVersionAtom)
			)
				continue;
			if (!snapshot.catalog || !Array.isArray(snapshot.catalog.groups)) return;
			store.set(applyFlowstokenCatalogSnapshotAtom, snapshot);
			loadedAt = Date.now();
			return;
		}
		throw new Error(i18n.t("common:flowstokenAccount.syncFailed"));
	})().catch((error: unknown) => {
		if (current !== generation) return followLatest();
		throw error;
	});
	inflight = task;
	latestTask = { generation: current, promise: task };
	void task
		.finally(() => {
			if (inflight === task) inflight = null;
		})
		.catch(() => {});
	return observe(task);
}

export function catalogGroupForProvider(
	catalog: FlowstokenCatalog | null,
	providerId: string,
): FlowstokenCatalogGroup | null {
	const canonical = canonicalFlowstokenProviderId(providerId);
	return catalog?.groups.find((g) => g.providerId === canonical) ?? null;
}

/** Titles are display data; a rename never changes the billing group or saved model key. */
export function catalogGroupTitle(group: FlowstokenCatalogGroup, language: string): string {
	const lang = language.startsWith("zh") ? "zh" : "en";
	if (group.titles?.[lang]) return group.titles[lang];
	const legacyTitles: Record<string, string> = { smart: "智能组", default: "普通组", vip: "官方组" };
	if (lang === "en" && group.title === legacyTitles[group.id]) {
		if (group.id === "smart") return i18n.t("common:modelSelect.groupSmart");
		if (group.id === "default") return i18n.t("common:modelSelect.groupDefault");
		if (group.id === "vip") return i18n.t("common:modelSelect.groupOfficial");
	}
	return group.title;
}

export interface FlowstokenModelEntry {
	vendorId: string;
	vendorName: string;
	vendorIcon?: string;
	vendorMono: boolean;
	name: string;
	isNew: boolean;
	tags: string[];
	vision: boolean;
	image: boolean;
	kind?: FlowstokenCatalogModel["kind"];
}

/** (providerId, modelId) → catalog entry；`isNew` 按 `released` 与 `newWindowDays` 现算。 */
export function catalogModelEntry(
	catalog: FlowstokenCatalog | null,
	providerId: string,
	modelId: string,
	now: number = Date.now(),
): FlowstokenModelEntry | null {
	const group = catalogGroupForProvider(catalog, providerId);
	if (!catalog || !group) return null;
	for (const vendor of group.vendors) {
		for (const model of vendor.models) {
			if (model.id !== modelId) continue;
			const releasedMs = (model.released ?? 0) * 1000;
			return {
				vendorId: vendor.id,
				vendorName: vendor.name,
				vendorIcon: vendor.icon ? `${catalog.iconBase}${vendor.icon}` : undefined,
				vendorMono: vendor.mono,
				name: model.name,
				isNew: releasedMs > 0 && releasedMs <= now && now - releasedMs < catalog.newWindowDays * DAY_MS,
				tags: model.tags,
				vision: model.vision,
				image: model.image,
				kind: model.kind,
			};
		}
	}
	return null;
}
