import { revalidateFlowstokenCatalog } from "@shared/store/flowstoken-catalog";
import { modelCatalog } from "@shared/store/model-catalog";
import { useThemeComponent } from "@vetta-org/theme-sdk";
import { type ModelSelectorTriggerVariant, ModelSelectorView } from "@vetta-org/theme-ui/chat";
import { fmtMultiplier } from "@vetta-org/theme-ui/shared";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useFlowstokenPicker } from "../../../domains/flowstoken/useFlowstokenPicker";
import { modelOptionFromIndex } from "./model-option-identity";
import { resolveReasoning } from "./resolveReasoning";
import { type ModelOption, useModelOptions } from "./useModelOptions";
import type { ModelPickerReasoning } from "./useModelPickerModel";

/** Optional reasoning-level column for a model picker. Controlled by the caller. */
export type ModelSelectReasoning = ModelPickerReasoning;

export interface ModelSelectProps {
	/** Currently selected key ("provider/modelId"), or null when unset */
	value: string | null;
	/** Fired on selection; null only when allowClear and the user clears */
	onChange: (key: string | null) => void;
	/** Show an explicit "unset" entry so the selection can be cleared */
	allowClear?: boolean;
	clearLabel?: string;
	ariaLabel?: string;
	disabled?: boolean;
	/** Trigger text when nothing is selected (defaults to common placeholder) */
	placeholder?: string;
	/** Extra classes for the trigger button (sizing/shape per call site) */
	triggerClassName?: string;
	/** Extra classes for the popup menu (e.g. a higher z-index inside a raised overlay) */
	menuClassName?: string;
	/** 触发器形态；表单里默认 `field`（带边框的选择框）。 */
	variant?: ModelSelectorTriggerVariant;
	/** 打「默认」徽章的模型；缺省为全局默认模型。 */
	defaultKey?: string;
	/** When value is empty, auto-apply the configured default model once */
	autoSelectDefault?: boolean;
	/** Fires whenever the resolved selected option changes (load + change) */
	onSelectedOptionChange?: (option: ModelOption | null) => void;
	/** When set, adds a reasoning-level column for the selected model. */
	reasoning?: ModelSelectReasoning;
}

/**
 * 受控的模型选择器（设置页、审批卡、定时任务、批量任务、团队成员、插件表单…）。
 *
 * 与输入栏右下角的选择器是同一个视图、同一份 FlowsToken 目录（计费分组 +
 * useFlowstokenPicker），只在「选中写到哪」和触发器形态上不同。主题对
 * `chat.modelSelectorView` 的覆盖在这里同样生效。
 */
export function ModelSelect({
	value,
	onChange,
	allowClear = false,
	clearLabel,
	ariaLabel,
	disabled = false,
	placeholder,
	triggerClassName,
	menuClassName,
	variant = "field",
	defaultKey: defaultKeyOverride,
	autoSelectDefault = false,
	onSelectedOptionChange,
	reasoning,
}: ModelSelectProps): JSX.Element {
	const { t } = useTranslation("common");
	const ThemedModelSelectorView = useThemeComponent("chat.modelSelectorView", ModelSelectorView);
	const { options, grouped, defaultKey: globalDefaultKey, iconFor, labelFor } = useModelOptions();
	const defaultKey = defaultKeyOverride ?? globalDefaultKey;
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
	// 选中后菜单保持打开、让用户接着在第三栏选思考强度的模型；与输入栏选择器同一规则。
	const reasoningModelKeys = useMemo(
		() =>
			reasoning
				? new Set(options.filter((option) => resolveReasoning(option)).map((option) => option.key))
				: undefined,
		[reasoning, options],
	);
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
	// 目录为空、没有选中值、也没有空值项时没东西可画，与输入栏选择器一致。
	if (options.length === 0 && !value && !allowClear) return <></>;
	return (
		<ThemedModelSelectorView
			selectedModel={selectedOption?.key ?? value ?? undefined}
			selectedOption={selectedFallback}
			selectedUnavailable={picker.selectedUnavailable}
			currentLevel={currentLevel}
			menuLevels={menuLevels}
			reasoningModelKeys={reasoningModelKeys}
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
			triggerVariant={variant}
			classNames={{ trigger: triggerClassName, content: menuClassName }}
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
				moreProviders: (count: number) => t("modelSelect.moreProviders", { count }),
				fewerProviders: t("modelSelect.fewerProviders"),
				info: {
					button: t("modelSelect.info.button"),
					source: t("modelSelect.info.source"),
					id: t("modelSelect.info.id"),
					contextWindow: t("modelSelect.info.contextWindow"),
					maxOutput: t("modelSelect.info.maxOutput"),
					inputModes: t("modelSelect.info.inputModes"),
					reasoning: t("modelSelect.info.reasoning"),
					reasoningSupported: t("modelSelect.info.reasoningSupported"),
					multiplier: t("modelSelect.info.multiplier"),
					modality: (modality: string) => t(`modelSelect.info.modality.${modality}`, { defaultValue: modality }),
				},
			}}
			onModelSelect={onChange}
			onReasoningSelect={(level) => reasoning?.onChange(level)}
			onOpenChange={handleOpenChange}
		/>
	);
}
