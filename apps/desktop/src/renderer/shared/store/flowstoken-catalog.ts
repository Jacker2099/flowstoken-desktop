import type { FlowstokenCatalog, FlowstokenCatalogGroup } from "@preload/api";
import { getDefaultStore } from "jotai";
import { flowstokenCatalogAtom } from "./model-catalog-atoms";

const TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/**
 * 从主进程取整份服务器下发的模型目录（分组、厂商、顺序、显示名、NEW 窗口都在里面）。
 * TTL 内复用上次结果；取不到（未登录、离线、非 FlowsToken 构建）时保持原值，
 * 选择器退回 providers 自带的原始列表。
 */
export function revalidateFlowstokenCatalog(now: number = Date.now()): Promise<void> {
	if (inflight) return inflight;
	if (loadedAt && now - loadedAt < TTL_MS) return Promise.resolve();
	const getCatalog = window.vetta?.flowstoken?.getCatalog;
	if (!getCatalog) return Promise.resolve();
	inflight = getCatalog()
		.then((catalog) => {
			if (catalog && Array.isArray(catalog.groups) && catalog.groups.length > 0) {
				getDefaultStore().set(flowstokenCatalogAtom, catalog);
				loadedAt = Date.now();
			}
		})
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

export function catalogGroupForProvider(
	catalog: FlowstokenCatalog | null,
	providerId: string,
): FlowstokenCatalogGroup | null {
	return catalog?.groups.find((g) => g.providerId === providerId) ?? null;
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
			};
		}
	}
	return null;
}
