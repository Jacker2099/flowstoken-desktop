/**
 * Ordering and labelling of FlowsToken group models for the model picker.
 *
 * Vendors: foreign frontier labs first, then other foreign vendors, then Chinese vendors. Within a vendor models
 * are grouped by release period (last 30 days, 3 months, 6 months, a year, older) and, inside a period, the most
 * capable (highest priced) model comes first; image-generation models go last. Price alone is not used across
 * periods (an old flagship like Opus 4 at $75/M output would sit above the current one), and version numbers are
 * not compared across product lines (Gemma 4 vs Gemini 3.8, Llama 4 vs Muse 1.3).
 */

/** Subset of a `/api/pricing` row this module needs. */
export interface PricingModel {
	model_name: string;
	vendor_id?: number | null;
	model_ratio?: number | null;
	completion_ratio?: number | null;
	quota_type?: number | null;
	supported_endpoint_types?: string[] | null;
}

export interface PricingVendor {
	id: number;
	name: string;
}

export interface OrderedGroupModel {
	id: string;
	/** Display name: the id without its `vendor/` routing prefix (the vendor is shown as a subheader). */
	name: string;
	vendor: string;
	isNew: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const NEW_MODEL_WINDOW_MS = 30 * DAY_MS;
/** Upper bounds (age) of the release periods, newest first. */
const RELEASE_PERIODS_MS = [30, 90, 180, 365].map((days) => days * DAY_MS);

function releasePeriod(releasedMs: number, now: number): number {
	if (releasedMs <= 0) return RELEASE_PERIODS_MS.length + 1;
	const at = RELEASE_PERIODS_MS.findIndex((bound) => now - releasedMs < bound);
	return at < 0 ? RELEASE_PERIODS_MS.length : at;
}

const FRONTIER = ["Anthropic", "OpenAI", "Google", "xAI"];
const FOREIGN = ["Meta", "Mistral", "Amazon", "Cohere", "Perplexity", "NVIDIA"];
const CHINESE = [
	"DeepSeek",
	"阿里巴巴",
	"Moonshot",
	"智谱",
	"MiniMax",
	"字节跳动",
	"腾讯",
	"小米",
	"阶跃星辰",
	"蚂蚁百灵",
	"Meituan",
	"快手",
	"讯飞",
];
const OTHER_VENDOR = "其他";

function vendorRank(vendor: string): [number, number, string] {
	for (const [tier, list] of [FRONTIER, FOREIGN, CHINESE].entries()) {
		const at = list.indexOf(vendor);
		if (at >= 0) return [tier === 2 ? 3 : tier, at, vendor];
	}
	// Unlisted vendors: CJK names are Chinese vendors; the rest sit between listed foreign and Chinese vendors.
	if (vendor === OTHER_VENDOR) return [5, 0, vendor];
	return [/[\u4e00-\u9fff]/.test(vendor) ? 4 : 2, 0, vendor];
}

function outputPrice(model: PricingModel): number {
	return Number(model.model_ratio ?? 0) * Number(model.completion_ratio ?? 1);
}

function isImageModel(model: PricingModel): boolean {
	return (model.supported_endpoint_types ?? []).includes("image-generation") || model.quota_type === 1;
}

export function orderGroupModels(
	models: readonly PricingModel[],
	vendors: readonly PricingVendor[],
	released: Readonly<Record<string, number>>,
	now: number = Date.now(),
): OrderedGroupModel[] {
	const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
	const rows = models.map((model) => {
		const vendor = (model.vendor_id != null && vendorName.get(model.vendor_id)) || OTHER_VENDOR;
		const releasedMs = (released[model.model_name] ?? 0) * 1000;
		return { model, vendor, releasedMs, rank: vendorRank(vendor) };
	});
	rows.sort(
		(a, b) =>
			a.rank[0] - b.rank[0] ||
			a.rank[1] - b.rank[1] ||
			a.rank[2].localeCompare(b.rank[2]) ||
			Number(isImageModel(a.model)) - Number(isImageModel(b.model)) ||
			releasePeriod(a.releasedMs, now) - releasePeriod(b.releasedMs, now) ||
			outputPrice(b.model) - outputPrice(a.model) ||
			b.releasedMs - a.releasedMs ||
			a.model.model_name.localeCompare(b.model.model_name),
	);
	return rows.map(({ model, vendor, releasedMs }) => ({
		id: model.model_name,
		name: model.model_name.slice(model.model_name.indexOf("/") + 1),
		vendor,
		isNew: releasedMs > 0 && releasedMs <= now && now - releasedMs < NEW_MODEL_WINDOW_MS,
	}));
}
