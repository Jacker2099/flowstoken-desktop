import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, net } from "electron";
import { parseCatalog } from "./catalog-schema.js";
import { FLOWSTOKEN_GROUPS, FLOWSTOKEN_SITE_URL } from "./constants.js";

export {
	isManagedFlowstokenProviderId,
	isValidBillingGroupId,
	parseCatalog,
	providerIdForGroup,
} from "./catalog-schema.js";

import type { FlowstokenCatalog, FlowstokenCatalogGroup, FlowstokenCatalogModel } from "./types.js";

/** Group model lists older than this are refreshed in the background (new site models reach logged-in clients). */
export const GROUP_MODELS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const CATALOG_CACHE_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
export const CATALOG_V1_URL = `${FLOWSTOKEN_SITE_URL}/brand/desktop-catalog.json`;
export const CATALOG_V2_URL = `${FLOWSTOKEN_SITE_URL}/brand/desktop-catalog-v2.json`;

let cached: { at: number; catalog: FlowstokenCatalog } | null = null;
let catalogRequest: Promise<FlowstokenCatalog | null> | null = null;
let diskPathOverride: string | null = null;

/** Latest locally observed directory for synchronous lease checks; never fetches or reads disk. */
export function peekCachedCatalog(): FlowstokenCatalog | null {
	return cached?.catalog ?? null;
}

function diskPath(schema: 1 | 2 = 2): string {
	return (
		diskPathOverride ??
		join(app.getPath("userData"), "flowstoken", schema === 2 ? "desktop-catalog-v2.json" : "desktop-catalog.json")
	);
}

async function fetchCatalogRemote(): Promise<FlowstokenCatalog | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		let resp = await net.fetch(CATALOG_V2_URL, { signal: controller.signal, cache: "no-store" });
		let expectedSchema = 2;
		if (resp.status === 404) {
			resp = await net.fetch(CATALOG_V1_URL, { signal: controller.signal, cache: "no-store" });
			expectedSchema = 1;
		}
		const catalog = resp.ok ? parseCatalog(await resp.json()) : null;
		return catalog?.schema === expectedSchema ? catalog : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function readDiskCatalog(): Promise<FlowstokenCatalog | null> {
	const paths = diskPathOverride ? [diskPathOverride] : [diskPath(2), diskPath(1)];
	for (const path of paths) {
		try {
			const saved: unknown = JSON.parse(await readFile(path, "utf8"));
			const catalog = parseCatalog(saved);
			const fetchedAt =
				typeof saved === "object" &&
				saved !== null &&
				"fetchedAt" in saved &&
				typeof saved.fetchedAt === "number" &&
				Number.isFinite(saved.fetchedAt) &&
				saved.fetchedAt > 0
					? saved.fetchedAt
					: undefined;
			if (catalog) return { ...catalog, source: "cache", ...(fetchedAt ? { fetchedAt } : {}) };
		} catch {
			// Try the preserved schema-1 cache when the new cache is unavailable.
		}
	}
	return null;
}

async function writeDiskCatalog(catalog: FlowstokenCatalog): Promise<void> {
	const path = diskPath(catalog.schema);
	const tmp = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	const { source: _source, ...directory } = catalog;
	await writeFile(tmp, JSON.stringify(directory), "utf8");
	await rename(tmp, path);
}

/**
 * Server-delivered catalog: in-memory TTL → network → disk cache. Returns null when
 * everything fails; callers fall back to the static lists.
 */
export function fetchCatalog(
	now: number = Date.now(),
	options: { force?: boolean } = {},
): Promise<FlowstokenCatalog | null> {
	if (catalogRequest) return catalogRequest;
	if (!options.force && cached && now - cached.at < CATALOG_CACHE_MS)
		return Promise.resolve({ ...cached.catalog, source: "cache" });
	catalogRequest = (async () => {
		const parsed = await fetchCatalogRemote();
		const remote: FlowstokenCatalog | null = parsed ? { ...parsed, source: "network", fetchedAt: Date.now() } : null;
		if (remote) {
			cached = { at: now, catalog: remote };
			try {
				await writeDiskCatalog(remote);
			} catch {
				// Cache write failure is non-fatal — the catalog already arrived.
			}
			return remote;
		}
		const disk: FlowstokenCatalog | null = cached ? { ...cached.catalog, source: "cache" } : await readDiskCatalog();
		if (disk) cached = { at: now, catalog: disk };
		return disk;
	})().finally(() => {
		catalogRequest = null;
	});
	return catalogRequest;
}

/** Flattened model list of one group in server order (vendors order × models order). */
export function catalogGroupModels(catalog: FlowstokenCatalog, groupId: string): FlowstokenCatalogModel[] {
	return catalog.groups.find((g) => g.id === groupId)?.vendors.flatMap((v) => v.models) ?? [];
}

/** Static catalog built from bundled defaults, used when neither network nor disk cache is available. */
export function fallbackCatalog(): FlowstokenCatalog {
	const groups: FlowstokenCatalogGroup[] = FLOWSTOKEN_GROUPS.map((group) => ({
		id: group.id,
		providerId: group.providerId,
		title: group.labelZh,
		subtitle: group.descriptionZh,
		defaultModel: group.id === "smart" ? "Bestoo-Auto" : undefined,
		vendors: [
			{
				id: "other",
				name: group.id === "smart" ? "Bestoo AI" : "",
				icon: null,
				mono: false,
				models: group.defaultModels.map((id) => ({
					id,
					name: id.slice(id.indexOf("/") + 1),
					released: null,
					tags: [],
					vision: false,
					image: id === "gpt-image-2" || id === "openai/gpt-image-2",
					kind: id === "gpt-image-2" || id === "openai/gpt-image-2" ? "image" : "chat",
				})),
			},
		],
	}));
	return {
		schema: 1,
		source: "fallback",
		generated: 0,
		pricingVersion: "",
		newWindowDays: 30,
		iconBase: `${FLOWSTOKEN_SITE_URL}/brand/vendor-icons/`,
		groups,
	};
}

/** Flattened fallback models for a single group (id → display name without `vendor/` prefix, no vendor). */
export function fallbackGroupModels(groupId: string): FlowstokenCatalogModel[] {
	return catalogGroupModels(fallbackCatalog(), groupId);
}

/** Catalog for the renderer: live/disk when available, static fallback otherwise. */
export async function getCatalog(options: { force?: boolean } = {}): Promise<FlowstokenCatalog> {
	return (await fetchCatalog(Date.now(), options)) ?? fallbackCatalog();
}

export function resetGroupCatalogCacheForTests(): void {
	cached = null;
}

export function setCatalogDiskPathForTests(path: string | null): void {
	diskPathOverride = path;
}
