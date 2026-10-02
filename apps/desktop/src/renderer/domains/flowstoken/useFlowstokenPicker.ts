import type { ModelOption } from "@shared/components/ModelSelect/useModelOptions";
import { i18n } from "@shared/i18n";
import { flowstokenCatalogAtom } from "@shared/store/model-catalog-atoms";
import { useAtomValue } from "jotai";
import { useMemo } from "react";

export interface FlowstokenPickerTab {
	/** Catalog group id ("smart" | "default" | "vip") or "all". */
	id: string;
	label: string;
	icon: string;
	/** Provider ids belonging to this tab; empty for "all". */
	providers: string[];
}

export interface FlowstokenVendorChip {
	id: string;
	name: string;
	iconUrl?: string;
	mono: boolean;
	count: number;
}

export interface FlowstokenPickerHighlight {
	tabId: string;
	title: string;
	badge: string;
	description: string;
	/** `providerId/modelId` the recommendation card selects on click. */
	modelKey?: string;
}

export interface FlowstokenGroupBadge {
	text: string;
	tone: "primary" | "blue" | "amber";
}

export interface FlowstokenPicker {
	enabled: boolean;
	tabs: FlowstokenPickerTab[];
	/** Tab to open on: the selected model's group, else smart. */
	initialTab: string;
	/** Vendor chips per tab id (server order). */
	vendorBarByTab: Record<string, FlowstokenVendorChip[]>;
	/** Smart-tab recommendation card copy (catalog, i18n fallback). */
	highlight: FlowstokenPickerHighlight | null;
	/** Small group badge rendered on the trigger for FlowsToken selections. */
	groupBadge: FlowstokenGroupBadge | null;
}

const GROUP_TONES: Record<string, FlowstokenGroupBadge["tone"]> = {
	smart: "primary",
	default: "blue",
	vip: "amber",
};
const GROUP_ICONS: Record<string, string> = {
	smart: "icon-[solar--magic-stick-3-linear]",
	default: "icon-[solar--bolt-linear]",
	vip: "icon-[solar--crown-linear]",
};
const GROUP_I18N_KEYS = {
	smart: "common:modelSelect.groupSmart",
	default: "common:modelSelect.groupDefault",
	vip: "common:modelSelect.groupOfficial",
} as const;

/**
 * FlowsToken model-picker state derived from the server catalog: group tabs,
 * per-tab vendor quick bar, smart-group recommendation card and the trigger
 * group badge. Returns `enabled: false` when no FlowsToken providers exist so
 * hosts render the plain upstream picker.
 */
export function useFlowstokenPicker(
	options: readonly ModelOption[],
	grouped: ReadonlyMap<string, ModelOption[]>,
	selectedModel: string | null | undefined,
): FlowstokenPicker {
	const catalog = useAtomValue(flowstokenCatalogAtom);

	return useMemo(() => {
		const providers = new Set(grouped.keys());
		const groups = (catalog?.groups ?? []).filter((g) => providers.has(g.providerId)
			|| (g.id === "default" && providers.has("flowstoken-normal")));
		if (groups.length === 0) {
			return { enabled: false, tabs: [], initialTab: "all", vendorBarByTab: {}, highlight: null, groupBadge: null };
		}

		const tabs: FlowstokenPickerTab[] = groups.map((g) => ({
			id: g.id,
			label: g.title || i18n.t(GROUP_I18N_KEYS[g.id] ?? "common:modelSelect.groupDefault"),
			icon: GROUP_ICONS[g.id] ?? "",
			// flowstoken-normal is the legacy id of the default group from earlier releases.
			providers:
				g.id === "default" && providers.has("flowstoken-normal")
					? [g.providerId, "flowstoken-normal"]
					: [g.providerId],
		}));
		tabs.push({ id: "all", label: i18n.t("common:modelSelect.groupAll"), icon: "", providers: [] });

		const selectedProvider = options.find((m) => m.key === selectedModel)?.provider;
		const selectedTab = tabs.find((tab) => selectedProvider && tab.providers.includes(selectedProvider));
		const selectedGroup = groups.find((g) => g.id === selectedTab?.id);
		const initialTab = selectedGroup?.id ?? (groups.some((g) => g.id === "smart") ? "smart" : groups[0].id);

		const vendorBarByTab: Record<string, FlowstokenVendorChip[]> = {};
		for (const group of groups) {
			const groupModels = (tabs.find((tab) => tab.id === group.id)?.providers ?? [])
				.flatMap((provider) => grouped.get(provider) ?? []);
			vendorBarByTab[group.id] = group.vendors
				.map((vendor) => ({
					id: vendor.id,
					name: vendor.name,
					iconUrl: vendor.icon ? `${catalog?.iconBase ?? ""}${vendor.icon}` : undefined,
					mono: vendor.mono,
					count: groupModels.filter((m) => m.vendorId === vendor.id).length,
				}))
				.filter((chip) => chip.count > 0);
		}

		const smart = groups.find((g) => g.id === "smart");
		const smartModels = smart ? grouped.get(smart.providerId) ?? [] : [];
		const recommendation = smartModels.find((model) => model.modelId === smart?.defaultModel)
			?? smartModels.find((model) => smart?.vendors.some((vendor) => vendor.models.some((entry) =>
				entry.id === model.modelId && !entry.image)));
		const highlight: FlowstokenPickerHighlight | null = smart
			? {
					tabId: "smart",
					title: smart.highlight?.title ?? i18n.t("common:modelSelect.smartHighlightTitle"),
					badge: smart.highlight?.badge ?? i18n.t("common:modelSelect.smartHighlightBadge"),
					description: smart.highlight?.description ?? i18n.t("common:modelSelect.smartHighlightDescription"),
					modelKey: recommendation?.key,
				}
			: null;

		const badgeGroup = selectedGroup;
		const groupBadge: FlowstokenGroupBadge | null = badgeGroup
			? {
					text: badgeGroup.title || i18n.t(GROUP_I18N_KEYS[badgeGroup.id] ?? "common:modelSelect.groupDefault"),
					tone: GROUP_TONES[badgeGroup.id] ?? "primary",
				}
			: null;

		return { enabled: true, tabs, initialTab, vendorBarByTab, highlight, groupBadge };
	}, [catalog, grouped, options, selectedModel]);
}
