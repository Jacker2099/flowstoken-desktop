import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, net } from "electron";
import { FLOWSTOKEN_GROUPS, FLOWSTOKEN_SITE_URL, type FlowstokenGroupId } from "./constants.js";
import type {
	FlowstokenCatalog,
	FlowstokenCatalogGroup,
	FlowstokenCatalogModel,
	FlowstokenCatalogVendor,
} from "./types.js";

/** Group model lists older than this are refreshed in the background (new site models reach logged-in clients). */
export const GROUP_MODELS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CATALOG_CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const CATALOG_URL = `${FLOWSTOKEN_SITE_URL}/brand/desktop-catalog.json`;

let cached: { at: number; catalog: FlowstokenCatalog } | null = null;
let diskPathOverride: string | null = null;

function diskPath(): string {
	return diskPathOverride ?? join(app.getPath("userData"), "flowstoken", "desktop-catalog.json");
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asModel(value: unknown): FlowstokenCatalogModel | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Record<string, unknown>;
	const id = asString(row.id);
	const name = asString(row.name);
	if (!id || !name) return null;
	return {
		id,
		name,
		released: typeof row.released === "number" && Number.isFinite(row.released) ? row.released : null,
		tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [],
		vision: row.vision === true,
		image: row.image === true,
	};
}

function asVendor(value: unknown): FlowstokenCatalogVendor | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Record<string, unknown>;
	const id = asString(row.id);
	const name = asString(row.name);
	if (!id || !name || !Array.isArray(row.models)) return null;
	const models = row.models.map(asModel);
	if (models.some((m) => m === null)) return null;
	return {
		id,
		name,
		icon: typeof row.icon === "string" && row.icon.length > 0 ? row.icon : null,
		mono: row.mono === true,
		models: models as FlowstokenCatalogModel[],
	};
}

function asGroup(value: unknown): FlowstokenCatalogGroup | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Record<string, unknown>;
	const id = asString(row.id);
	const providerId = asString(row.providerId);
	const title = asString(row.title);
	if (!id || !providerId || !title || !Array.isArray(row.vendors)) return null;
	const vendors = row.vendors.map(asVendor);
	if (vendors.some((v) => v === null)) return null;
	const highlight =
		typeof row.highlight === "object" && row.highlight !== null
			? (() => {
					const h = row.highlight as Record<string, unknown>;
					const hTitle = asString(h.title);
					const hBadge = asString(h.badge);
					const hDescription = asString(h.description);
					return hTitle && hBadge && hDescription
						? { title: hTitle, badge: hBadge, description: hDescription }
						: null;
				})()
			: null;
	return {
		id: id as FlowstokenCatalogGroup["id"],
		providerId,
		title,
		subtitle: typeof row.subtitle === "string" ? row.subtitle : "",
		defaultModel: typeof row.defaultModel === "string" ? row.defaultModel : undefined,
		highlight: highlight ?? undefined,
		vendors: vendors as FlowstokenCatalogVendor[],
	};
}

/** Narrow untrusted JSON into the schema-1 catalog; returns null on any boundary violation. */
export function parseCatalog(data: unknown): FlowstokenCatalog | null {
	if (typeof data !== "object" || data === null) return null;
	const row = data as Record<string, unknown>;
	if (row.schema !== 1 || !Array.isArray(row.groups)) return null;
	const groups = row.groups.map(asGroup);
	if (groups.some((g) => g === null)) return null;
	const typed = groups as FlowstokenCatalogGroup[];
	if (!typed.every((g) => g.id === "smart" || g.id === "default" || g.id === "vip")) return null;
	if (typed.length === 0) return null;
	return {
		schema: 1,
		generated: typeof row.generated === "number" ? row.generated : 0,
		pricingVersion: typeof row.pricingVersion === "string" ? row.pricingVersion : "",
		newWindowDays: typeof row.newWindowDays === "number" && row.newWindowDays > 0 ? row.newWindowDays : 30,
		iconBase: typeof row.iconBase === "string" ? row.iconBase : `${FLOWSTOKEN_SITE_URL}/brand/vendor-icons/`,
		groups: typed,
	};
}

async function fetchCatalogRemote(): Promise<FlowstokenCatalog | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await net.fetch(CATALOG_URL, { signal: controller.signal });
		return resp.ok ? parseCatalog(await resp.json()) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function readDiskCatalog(): Promise<FlowstokenCatalog | null> {
	try {
		return parseCatalog(JSON.parse(await readFile(diskPath(), "utf8")));
	} catch {
		return null;
	}
}

async function writeDiskCatalog(catalog: FlowstokenCatalog): Promise<void> {
	const path = diskPath();
	const tmp = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(tmp, JSON.stringify(catalog), "utf8");
	await rename(tmp, path);
}

/**
 * Server-delivered catalog: in-memory TTL → network → disk cache. Returns null when
 * everything fails; callers fall back to the static lists.
 */
export async function fetchCatalog(now: number = Date.now()): Promise<FlowstokenCatalog | null> {
	if (cached && now - cached.at < CATALOG_CACHE_MS) return cached.catalog;
	const remote = await fetchCatalogRemote();
	if (remote) {
		cached = { at: now, catalog: remote };
		try {
			await writeDiskCatalog(remote);
		} catch {
			// Cache write failure is non-fatal — the catalog already arrived.
		}
		return remote;
	}
	const disk = await readDiskCatalog();
	if (disk) cached = { at: now, catalog: disk };
	return disk;
}

/** Flattened model list of one group in server order (vendors order × models order). */
export function catalogGroupModels(catalog: FlowstokenCatalog, groupId: FlowstokenGroupId): FlowstokenCatalogModel[] {
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
					image: false,
				})),
			},
		],
	}));
	return {
		schema: 1,
		generated: 0,
		pricingVersion: "",
		newWindowDays: 30,
		iconBase: `${FLOWSTOKEN_SITE_URL}/brand/vendor-icons/`,
		groups,
	};
}

/** Flattened fallback models for a single group (id → display name without `vendor/` prefix, no vendor). */
export function fallbackGroupModels(groupId: FlowstokenGroupId): FlowstokenCatalogModel[] {
	return catalogGroupModels(fallbackCatalog(), groupId);
}

/** Catalog for the renderer: live/disk when available, static fallback otherwise. */
export async function getCatalog(): Promise<FlowstokenCatalog> {
	return (await fetchCatalog()) ?? fallbackCatalog();
}

export function resetGroupCatalogCacheForTests(): void {
	cached = null;
}

export function setCatalogDiskPathForTests(path: string | null): void {
	diskPathOverride = path;
}
