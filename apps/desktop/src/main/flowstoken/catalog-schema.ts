import type { FlowstokenModelKind, FlowstokenReasoningLevel } from "../../shared/flowstoken-catalog-policy.js";
import {
	FLOWSTOKEN_MODEL_KINDS,
	FLOWSTOKEN_REASONING_LEVELS,
	isValidBillingGroupId,
	providerIdForGroup,
} from "../../shared/flowstoken-catalog-policy.js";

export {
	isManagedFlowstokenProviderId,
	isValidBillingGroupId,
	providerIdForGroup,
} from "../../shared/flowstoken-catalog-policy.js";

import { FLOWSTOKEN_GROUPS, FLOWSTOKEN_SITE_URL } from "./constants.js";
import type {
	FlowstokenCatalog,
	FlowstokenCatalogGroup,
	FlowstokenCatalogModel,
	FlowstokenCatalogVendor,
} from "./types.js";

type Row = Record<string, unknown>;
const MAX_GROUPS = 64;
const FORBIDDEN_CONFIG = [
	"baseUrl",
	"baseURL",
	"apiKey",
	"headers",
	"endpoint",
	"api",
	"code",
	"script",
	"execute",
	"html",
	"css",
];

function asRow(value: unknown): Row | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const row = value as Row;
	return FORBIDDEN_CONFIG.some((key) => Object.hasOwn(row, key)) ? null : row;
}

function text(value: unknown, maximum = 256): string | null {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
		? value
		: null;
}

function positiveLimit(value: unknown): number | undefined | null {
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000 ? value : null;
}

function modelPurpose(row: Row): {
	kind: FlowstokenModelKind;
	image: boolean;
	reasoningLevels?: FlowstokenReasoningLevel[];
	defaultReasoningLevel?: FlowstokenReasoningLevel;
} | null {
	const kind =
		row.kind === undefined
			? row.image === true
				? "image"
				: "chat"
			: FLOWSTOKEN_MODEL_KINDS.find((entry) => entry === row.kind);
	if (!kind || (row.image !== undefined && row.image !== (kind === "image"))) return null;
	let reasoningLevels: FlowstokenReasoningLevel[] | undefined;
	if (row.reasoningLevels !== undefined) {
		if (!Array.isArray(row.reasoningLevels)) return null;
		reasoningLevels = [];
		for (const value of row.reasoningLevels) {
			const supported = FLOWSTOKEN_REASONING_LEVELS.find((level) => level === value);
			if (!supported || reasoningLevels.includes(supported)) return null;
			reasoningLevels.push(supported);
		}
	}
	const defaultReasoningLevel =
		row.defaultReasoningLevel === undefined
			? undefined
			: reasoningLevels?.find((level) => level === row.defaultReasoningLevel);
	if (row.defaultReasoningLevel !== undefined && !defaultReasoningLevel) return null;
	return {
		kind,
		image: kind === "image",
		...(reasoningLevels ? { reasoningLevels } : {}),
		...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
	};
}

function asModel(value: unknown, schema: 1 | 2): FlowstokenCatalogModel | null {
	const row = asRow(value);
	if (!row) return null;
	const id = text(row.id);
	const name = text(row.name);
	if (!id || !name) return null;
	const purpose = modelPurpose(row);
	if (!purpose) return null;
	if (
		schema === 2 &&
		["vision", "image", "reasoning", "recommended"].some(
			(key) => row[key] !== undefined && typeof row[key] !== "boolean",
		)
	)
		return null;
	const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => Boolean(text(tag, 80))) : [];
	if (
		schema === 2 &&
		(tags.length > 32 || (row.tags !== undefined && (!Array.isArray(row.tags) || tags.length !== row.tags.length)))
	)
		return null;
	const contextWindow = positiveLimit(row.contextWindow);
	const maxTokens = positiveLimit(row.maxTokens);
	if (contextWindow === null || maxTokens === null || (contextWindow && maxTokens && maxTokens > contextWindow))
		return null;
	if (
		schema === 2 &&
		row.released !== undefined &&
		row.released !== null &&
		(typeof row.released !== "number" || !Number.isFinite(row.released) || row.released < 0)
	)
		return null;
	return {
		id,
		name,
		released: typeof row.released === "number" && Number.isFinite(row.released) ? row.released : null,
		tags,
		vision: row.vision === true,
		...purpose,
		...(typeof row.reasoning === "boolean" ? { reasoning: row.reasoning } : {}),
		...(typeof row.recommended === "boolean" ? { recommended: row.recommended } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
	};
}

function asVendor(value: unknown, schema: 1 | 2): FlowstokenCatalogVendor | null {
	const row = asRow(value);
	if (!row || !Array.isArray(row.models) || row.models.length > 5000) return null;
	const id = text(row.id, 128);
	const name = text(row.name);
	if (!id || !name || (schema === 2 && row.mono !== undefined && typeof row.mono !== "boolean")) return null;
	const icon =
		row.icon === null || row.icon === undefined || (schema === 1 && row.icon === "") ? null : text(row.icon, 128);
	if (icon !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(svg|png|webp|jpg|jpeg)$/.test(icon)) return null;
	if (row.icon !== undefined && row.icon !== null && !(schema === 1 && row.icon === "") && icon === null) return null;
	const models = row.models.map((model) => asModel(model, schema));
	if (models.some((model) => model === null)) return null;
	return { id, name, icon, mono: row.mono === true, models: models.filter((model) => model !== null) };
}

function asGroup(value: unknown, schema: 1 | 2): FlowstokenCatalogGroup | null {
	const row = asRow(value);
	if (!row || !isValidBillingGroupId(row.id) || !Array.isArray(row.vendors) || row.vendors.length > 128) return null;
	const id = row.id;
	const legacy = FLOWSTOKEN_GROUPS.find((entry) => entry.id === id);
	const providerId = providerIdForGroup(id);
	if (schema === 1 && (!legacy || row.providerId !== providerId)) return null;
	if (
		schema === 2 &&
		((row.providerId !== undefined && row.providerId !== providerId) ||
			(row.accountGroup !== undefined && row.accountGroup !== id))
	)
		return null;
	const title = text(row.title);
	if (!title) return null;
	const titles = row.titles === undefined ? undefined : asRow(row.titles);
	if (row.titles !== undefined && !titles) return null;
	const zh = titles?.zh === undefined ? undefined : text(titles.zh);
	const en = titles?.en === undefined ? undefined : text(titles.en);
	if (zh === null || en === null) return null;
	if (schema === 2 && row.subtitle !== undefined && (typeof row.subtitle !== "string" || row.subtitle.length > 1000))
		return null;
	const vendors = row.vendors.map((vendor) => asVendor(vendor, schema));
	if (vendors.some((vendor) => vendor === null)) return null;
	const vendorIds = new Set<string>();
	const modelIds = new Set<string>();
	const uniqueVendors: FlowstokenCatalogVendor[] = [];
	for (const vendor of vendors) {
		if (!vendor || vendorIds.has(vendor.id)) return null;
		vendorIds.add(vendor.id);
		uniqueVendors.push({
			...vendor,
			models: vendor.models.filter((model) => {
				if (modelIds.has(model.id)) return false;
				modelIds.add(model.id);
				return true;
			}),
		});
	}
	const defaultModel =
		row.defaultModel === undefined || row.defaultModel === null ? undefined : text(row.defaultModel);
	if (defaultModel === null || (schema === 2 && defaultModel !== undefined && !modelIds.has(defaultModel)))
		return null;
	const highlight = asRow(row.highlight);
	const highlightTitle = highlight && text(highlight.title);
	const badge = highlight && text(highlight.badge, 80);
	const description = highlight && text(highlight.description, 1000);
	if (
		schema === 2 &&
		row.highlight !== undefined &&
		row.highlight !== null &&
		(!highlightTitle || !badge || !description)
	)
		return null;
	return {
		id,
		providerId,
		title,
		...(titles ? { titles: { ...(zh ? { zh } : {}), ...(en ? { en } : {}) } } : {}),
		subtitle: typeof row.subtitle === "string" && row.subtitle.length <= 1000 ? row.subtitle : "",
		...(defaultModel ? { defaultModel } : {}),
		...(highlightTitle && badge && description ? { highlight: { title: highlightTitle, badge, description } } : {}),
		vendors: uniqueVendors,
	};
}

/** Parse an entire directory or reject it; its display metadata cannot change billing bindings. */
export function parseCatalog(data: unknown): FlowstokenCatalog | null {
	const row = asRow(data);
	if (!row || (row.schema !== 1 && row.schema !== 2) || !Array.isArray(row.groups) || row.groups.length > MAX_GROUPS)
		return null;
	const schema = row.schema;
	if (
		schema === 2 &&
		((row.generated !== undefined &&
			(typeof row.generated !== "number" || !Number.isFinite(row.generated) || row.generated < 0)) ||
			(row.pricingVersion !== undefined &&
				(typeof row.pricingVersion !== "string" || row.pricingVersion.length > 128)) ||
			(row.newWindowDays !== undefined &&
				(typeof row.newWindowDays !== "number" ||
					!Number.isFinite(row.newWindowDays) ||
					row.newWindowDays <= 0 ||
					row.newWindowDays > 3650)))
	)
		return null;
	const revision = row.revision === undefined ? undefined : text(row.revision, 128);
	if ((schema === 2 && !revision) || revision === null) return null;
	const groups = row.groups.map((group) => asGroup(group, schema));
	if (groups.some((group) => group === null)) return null;
	const typed = groups.filter((group) => group !== null);
	if ((schema === 1 && typed.length === 0) || new Set(typed.map((group) => group.id)).size !== typed.length)
		return null;
	let iconBase = `${FLOWSTOKEN_SITE_URL}/brand/vendor-icons/`;
	if (row.iconBase !== undefined) {
		if (typeof row.iconBase !== "string") return null;
		try {
			const url = new URL(row.iconBase);
			if (
				url.origin !== FLOWSTOKEN_SITE_URL ||
				!url.pathname.startsWith("/brand/vendor-icons/") ||
				!url.pathname.endsWith("/") ||
				url.username ||
				url.password ||
				url.search ||
				url.hash
			)
				return null;
			iconBase = url.href;
		} catch {
			return null;
		}
	}
	return {
		schema,
		...(revision ? { revision } : {}),
		generated: typeof row.generated === "number" && Number.isFinite(row.generated) ? row.generated : 0,
		pricingVersion: typeof row.pricingVersion === "string" ? row.pricingVersion : "",
		newWindowDays:
			typeof row.newWindowDays === "number" &&
			Number.isFinite(row.newWindowDays) &&
			row.newWindowDays > 0 &&
			row.newWindowDays <= 3650
				? row.newWindowDays
				: 30,
		iconBase,
		groups: typed,
	};
}
