import { net } from "electron";
import {
	FLOWSTOKEN_GROUPS,
	FLOWSTOKEN_SITE_URL,
	FLOWSTOKEN_SMART_GROUP_MODELS,
	type FlowstokenGroupId,
} from "./constants.js";
import { type OrderedGroupModel, orderGroupModels, type PricingModel, type PricingVendor } from "./model-order.js";
import type { FlowstokenModelMeta } from "./types.js";

/** Group model lists older than this are refreshed in the background (new site models reach logged-in clients). */
export const GROUP_MODELS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CATALOG_CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

export type GroupCatalog = Record<FlowstokenGroupId, readonly OrderedGroupModel[]>;

let cached: { at: number; catalog: GroupCatalog } | null = null;

async function fetchJson<T>(path: string): Promise<T | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await net.fetch(`${FLOWSTOKEN_SITE_URL}${path}`, { signal: controller.signal });
		return resp.ok ? ((await resp.json()) as T) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function smartModels(): OrderedGroupModel[] {
	return FLOWSTOKEN_SMART_GROUP_MODELS.map((id) => ({ id, name: id, vendor: "Bestoo", isNew: false }));
}

/**
 * Live, ordered model lists per group from the site's pricing API (and model release dates for the NEW badge).
 * Returns null when the pricing API is unavailable; callers keep what they already have.
 */
export async function fetchGroupCatalog(now: number = Date.now()): Promise<GroupCatalog | null> {
	if (cached && now - cached.at < CATALOG_CACHE_MS) return cached.catalog;
	const [pricing, released] = await Promise.all([
		fetchJson<{ data?: Array<PricingModel & { enable_groups?: string[] }>; vendors?: PricingVendor[] }>(
			"/api/pricing",
		),
		fetchJson<{ models?: Record<string, number> }>("/brand/model-released.json"),
	]);
	const rows = Array.isArray(pricing?.data) ? pricing.data.filter((row) => row.model_name?.trim()) : [];
	const inGroup = (group: string) => rows.filter((row) => (row.enable_groups ?? []).includes(group));
	const vendors = pricing?.vendors ?? [];
	const dates = released?.models ?? {};
	const catalog: GroupCatalog = {
		default: orderGroupModels(inGroup("default"), vendors, dates, now),
		smart: smartModels(),
		vip: orderGroupModels(inGroup("vip"), vendors, dates, now),
	};
	if (catalog.default.length === 0 || catalog.vip.length === 0) return null;
	cached = { at: now, catalog };
	return catalog;
}

/** Built-in lists for when the site is unreachable (first login offline): unordered ids, no badges. */
export function fallbackGroupModels(groupId: FlowstokenGroupId): OrderedGroupModel[] {
	const group = FLOWSTOKEN_GROUPS.find((g) => g.id === groupId);
	return (group?.defaultModels ?? []).map((id) => ({
		id,
		name: id.slice(id.indexOf("/") + 1),
		vendor: "",
		isNew: false,
	}));
}

/** Vendor and NEW badge per FlowsToken provider model, for the model picker. */
export async function getGroupModelMeta(): Promise<FlowstokenModelMeta> {
	const catalog = await fetchGroupCatalog();
	const meta: FlowstokenModelMeta = {};
	if (!catalog) return meta;
	for (const group of FLOWSTOKEN_GROUPS) {
		meta[group.providerId] = Object.fromEntries(
			catalog[group.id].map((model) => [model.id, { vendor: model.vendor, isNew: model.isNew }]),
		);
	}
	return meta;
}

export function resetGroupCatalogCacheForTests(): void {
	cached = null;
}
