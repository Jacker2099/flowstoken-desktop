import { revalidateFlowstokenCatalog } from "@shared/store/flowstoken-catalog";
import { modelCatalog } from "@shared/store/model-catalog";
import { ModelSelectorView } from "@vetta-org/theme-ui/chat";
import { fmtMultiplier } from "@vetta-org/theme-ui/shared";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useFlowstokenPicker } from "../../../domains/flowstoken/useFlowstokenPicker";
import { modelOptionFromIndex } from "./model-option-identity";
import { resolveReasoning } from "./resolveReasoning";
import { type ModelOption, useModelOptions } from "./useModelOptions";

export interface ModelSelectReasoning {
	value: string | undefined;
	onChange: (level: string) => void;
}

export interface ModelSelectProps {
	value: string | null;
	onChange: (key: string | null) => void;
	allowClear?: boolean;
	clearLabel?: string;
	ariaLabel?: string;
	disabled?: boolean;
	placeholder?: string;
	triggerClassName?: string;
	autoSelectDefault?: boolean;
	onSelectedOptionChange?: (option: ModelOption | null) => void;
	reasoning?: ModelSelectReasoning;
}

/** Every product entry uses the same pure catalog view as the conversation picker. */
export function ModelSelect({
	value,
	onChange,
	allowClear = false,
	clearLabel,
	ariaLabel,
	disabled = false,
	placeholder,
	triggerClassName,
	autoSelectDefault = false,
	onSelectedOptionChange,
	reasoning,
}: ModelSelectProps): JSX.Element {
	const { t } = useTranslation("common");
	const { options, grouped, defaultKey, iconFor, labelFor } = useModelOptions();
	const picker = useFlowstokenPicker(options, grouped, value);
	const byKey = useMemo(() => new Map(options.map((option) => [option.key, option])), [options]);
	const providerGroups = useMemo(
		() =>
			[...grouped].map(([provider, models]) => ({
				provider,
				models,
				label: labelFor(provider),
				icon: iconFor(provider),
			})),
		[grouped, labelFor, iconFor],
	);
	const selectedOption = value ? (modelOptionFromIndex(byKey, value) ?? null) : null;
	const resolved = useMemo(() => resolveReasoning(selectedOption), [selectedOption]);
	const menuLevels = useMemo(() => {
		if (!reasoning || !resolved) return [];
		return resolved.levels.includes("none")
			? ["none", ...resolved.levels.filter((level) => level !== "none" && level !== "off")]
			: ["off", ...resolved.levels.filter((level) => level !== "off")];
	}, [reasoning, resolved]);
	const currentLevel =
		resolved && reasoning
			? reasoning.value && menuLevels.includes(reasoning.value)
				? reasoning.value
				: resolved.default
			: undefined;
	useEffect(() => {
		if (autoSelectDefault && !value && defaultKey && modelOptionFromIndex(byKey, defaultKey)) onChange(defaultKey);
	}, [autoSelectDefault, value, defaultKey, byKey, onChange]);
	useEffect(() => {
		onSelectedOptionChange?.(selectedOption);
	}, [selectedOption, onSelectedOptionChange]);
	const handleOpenChange = useCallback((open: boolean) => {
		if (open) {
			void modelCatalog.revalidate().then(() => revalidateFlowstokenCatalog());
		}
	}, []);
	const handleCatalogRefresh = useCallback(async () => {
		await revalidateFlowstokenCatalog(Date.now(), { force: true });
		await modelCatalog.revalidate({ force: true, sources: ["local"] });
	}, []);
	const multiplierLabel = useCallback(
		(option: { key: string }) => {
			const multiplier = byKey.get(option.key)?.multiplier;
			if (!multiplier) return undefined;
			return multiplier.input === 0 && multiplier.output === 0
				? t("modelSelect.free")
				: t("modelSelect.multiplier", { value: fmtMultiplier(multiplier.input) });
		},
		[byKey, t],
	);
	const selectedFallback =
		value && !selectedOption
			? {
					key: value,
					provider: value.split("/", 1)[0],
					modelId: value.slice(value.indexOf("/") + 1),
					displayName: value.slice(value.indexOf("/") + 1),
				}
			: selectedOption;
	return (
		<ModelSelectorView
			selectedModel={selectedOption?.key ?? value ?? undefined}
			selectedOption={selectedFallback}
			selectedUnavailable={picker.selectedUnavailable}
			currentLevel={currentLevel}
			menuLevels={menuLevels}
			groups={providerGroups}
			defaultKey={defaultKey ? (modelOptionFromIndex(byKey, defaultKey)?.key ?? defaultKey) : undefined}
			tabs={picker.enabled ? picker.tabs : undefined}
			initialTab={picker.initialTab}
			vendorBarByTab={picker.vendorBarByTab}
			highlightByTab={picker.highlightByTab}
			onCatalogRefresh={picker.enabled || picker.selectedUnavailable ? handleCatalogRefresh : undefined}
			catalogStatus={picker.catalogStatus}
			triggerBadge={picker.groupBadge ?? undefined}
			ariaLabel={ariaLabel}
			disabled={disabled}
			classNames={{ trigger: triggerClassName }}
			emptyOption={
				allowClear ? { label: clearLabel ?? t("modelSelect.unset"), onSelect: () => onChange(null) } : undefined
			}
			labels={{
				placeholder: placeholder ?? t("modelSelect.placeholder"),
				searchPlaceholder: t("modelSelect.searchPlaceholder"),
				clearSearch: t("modelSelect.clearSearch"),
				noResults: t("modelSelect.noResults"),
				noResultsHint: t("modelSelect.noResultsHint"),
				reasoningHeader: t("modelSelect.reasoningHeader"),
				modelHeader: t("modelSelect.modelHeader"),
				cloudOnly: t("modelSelect.cloudOnly"),
				visionBadge: t("modelSelect.visionBadge"),
				defaultBadge: t("modelSelect.defaultBadge"),
				newBadge: t("modelSelect.newBadge"),
				allVendors: t("modelSelect.allVendors"),
				recommendationSelected: t("modelSelect.recommendationSelected"),
				recommendationAction: t("modelSelect.recommendationAction"),
				unavailableBadge: t("modelSelect.unavailableBadge"),
				unavailableHint: t("modelSelect.unavailableHint"),
				levelLabel: (level) => t(`modelSelect.reasoningLevel.${level}`, { defaultValue: level }),
				syncCatalog: t("modelSelect.syncCatalog"),
				cached: t("modelSelect.catalogCached"),
				fallback: t("modelSelect.catalogFallback"),
				refreshFailed: t("modelSelect.catalogRefreshFailed"),
				multiplierLabel,
			}}
			onModelSelect={onChange}
			onReasoningSelect={(level) => reasoning?.onChange(level)}
			onOpenChange={handleOpenChange}
		/>
	);
}
