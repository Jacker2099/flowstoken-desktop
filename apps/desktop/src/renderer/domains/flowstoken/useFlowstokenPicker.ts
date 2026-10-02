import type { ModelOption } from "@shared/components/ModelSelect/useModelOptions";
import { i18n } from "@shared/i18n";
import { catalogGroupTitle, catalogModelEntry } from "@shared/store/flowstoken-catalog";
import { flowstokenCatalogAtom } from "@shared/store/model-catalog-atoms";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	canonicalFlowstokenProviderId,
	isManagedFlowstokenProviderId,
} from "../../../shared/flowstoken-catalog-policy";

/** Outside the permitted billing-ID alphabet, so a real group named all stays distinct. */
export const FLOWSTOKEN_ALL_TAB_ID = "__all__";

export interface FlowstokenPickerTab {
	id: string;
	label: string;
	icon: string;
	providers: string[];
	modelCount: number;
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
	modelKey?: string;
}
export interface FlowstokenGroupBadge {
	text: string;
	tone: "primary" | "blue" | "amber";
}
export interface FlowstokenPicker {
	enabled: boolean;
	tabs: FlowstokenPickerTab[];
	initialTab: string;
	vendorBarByTab: Record<string, FlowstokenVendorChip[]>;
	highlight: FlowstokenPickerHighlight | null;
	highlightByTab: Record<string, FlowstokenPickerHighlight>;
	groupBadge: FlowstokenGroupBadge | null;
	selectedUnavailable: boolean;
	catalogStatus?: "network" | "cache" | "fallback";
}

const GROUP_ICONS: Record<string, string> = {
	smart: "icon-[solar--magic-stick-3-linear]",
	default: "icon-[solar--bolt-linear]",
	vip: "icon-[solar--crown-linear]",
};

/** Public catalog describes presentation; provider credentials and fees stay in main. */
export function useFlowstokenPicker(
	options: readonly ModelOption[],
	grouped: ReadonlyMap<string, ModelOption[]>,
	selectedModel: string | null | undefined,
): FlowstokenPicker {
	const catalog = useAtomValue(flowstokenCatalogAtom);
	const { i18n: languageSource } = useTranslation("common");
	const language = languageSource?.resolvedLanguage ?? languageSource?.language ?? "zh";
	return useMemo(() => {
		const providers = new Set(grouped.keys());
		const groups = (catalog?.groups ?? []).filter(
			(group) => providers.has(group.providerId) || (group.id === "default" && providers.has("flowstoken-normal")),
		);
		const selectedProvider = selectedModel?.slice(0, selectedModel.indexOf("/"));
		const selectedModelId = selectedModel?.slice(selectedModel.indexOf("/") + 1);
		const selectedUnavailable = Boolean(
			catalog &&
				selectedProvider &&
				isManagedFlowstokenProviderId(selectedProvider) &&
				(!selectedModelId ||
					!catalogModelEntry(catalog, selectedProvider, selectedModelId) ||
					catalogModelEntry(catalog, selectedProvider, selectedModelId)?.image ||
					(catalogModelEntry(catalog, selectedProvider, selectedModelId)?.kind !== undefined &&
						catalogModelEntry(catalog, selectedProvider, selectedModelId)?.kind !== "chat")),
		);
		const tabs: FlowstokenPickerTab[] = groups.map((group) => {
			const ids =
				group.id === "default" && providers.has("flowstoken-normal")
					? [group.providerId, "flowstoken-normal"]
					: [group.providerId];
			return {
				id: group.id,
				label: catalogGroupTitle(group, language),
				icon: Object.hasOwn(GROUP_ICONS, group.id)
					? GROUP_ICONS[group.id]
					: "icon-[solar--layers-minimalistic-linear]",
				providers: ids,
				modelCount: ids.reduce((count, provider) => count + (grouped.get(provider)?.length ?? 0), 0),
			};
		});
		tabs.push({
			id: FLOWSTOKEN_ALL_TAB_ID,
			label: i18n.t("common:modelSelect.groupAll"),
			icon: "",
			providers: [],
			modelCount: options.length,
		});
		const selectedGroup = groups.find(
			(group) => group.providerId === canonicalFlowstokenProviderId(selectedProvider ?? ""),
		);
		const availableTabs = tabs.filter((tab) => tab.providers.length > 0 && tab.modelCount > 0);
		const initialTab =
			selectedGroup?.id ??
			(selectedProvider && !isManagedFlowstokenProviderId(selectedProvider)
				? FLOWSTOKEN_ALL_TAB_ID
				: (availableTabs.find((tab) => tab.id === "smart")?.id ??
					availableTabs[0]?.id ??
					groups[0]?.id ??
					FLOWSTOKEN_ALL_TAB_ID));
		const vendorBarByTab: Record<string, FlowstokenVendorChip[]> = Object.create(null);
		const highlightByTab: Record<string, FlowstokenPickerHighlight> = Object.create(null);
		for (const group of groups) {
			const models = (tabs.find((tab) => tab.id === group.id)?.providers ?? []).flatMap(
				(provider) => grouped.get(provider) ?? [],
			);
			const counts = new Map<string, number>();
			for (const model of models)
				if (model.vendorId) counts.set(model.vendorId, (counts.get(model.vendorId) ?? 0) + 1);
			vendorBarByTab[group.id] = group.vendors
				.map((vendor) => ({
					id: vendor.id,
					name: vendor.name,
					iconUrl: vendor.icon ? `${catalog?.iconBase ?? ""}${vendor.icon}` : undefined,
					mono: vendor.mono,
					count: counts.get(vendor.id) ?? 0,
				}))
				.filter((vendor) => vendor.count > 0);
			const recommendation =
				models.find((model) => model.modelId === group.defaultModel) ??
				models.find((model) =>
					group.vendors.some((vendor) =>
						vendor.models.some((entry) => entry.id === model.modelId && entry.recommended && !entry.image),
					),
				) ??
				(group.id === "smart"
					? models.find((model) => !catalogModelEntry(catalog, model.provider, model.modelId)?.image)
					: undefined);
			if (recommendation)
				highlightByTab[group.id] = {
					tabId: group.id,
					modelKey: recommendation.key,
					title:
						group.highlight?.title ||
						(group.id === "smart"
							? i18n.t("common:modelSelect.smartHighlightTitle")
							: recommendation.displayName),
					badge: group.highlight?.badge || i18n.t("common:modelSelect.smartHighlightBadge"),
					description:
						group.highlight?.description ||
						(group.id === "smart" ? i18n.t("common:modelSelect.smartHighlightDescription") : group.subtitle),
				};
		}
		return {
			enabled: groups.length > 0,
			tabs: groups.length > 0 ? tabs : [],
			initialTab,
			vendorBarByTab,
			highlightByTab,
			highlight: highlightByTab.smart ?? null,
			selectedUnavailable,
			catalogStatus: catalog?.source,
			groupBadge: selectedGroup
				? {
						text: catalogGroupTitle(selectedGroup, language),
						tone: selectedGroup.id === "default" ? "blue" : selectedGroup.id === "vip" ? "amber" : "primary",
					}
				: null,
		};
	}, [catalog, grouped, options, selectedModel, language]);
}
