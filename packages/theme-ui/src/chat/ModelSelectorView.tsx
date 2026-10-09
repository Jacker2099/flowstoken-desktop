import { AnimatePresence, motion } from "motion/react";
import type { ChangeEvent, JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@vetta-org/ui/button";
import { cn } from "@vetta-org/ui/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@vetta-org/ui/dropdown-menu";
import { ThemeSurface } from "../appearance/ThemeSurface";
import { MultiplierTag } from "../shared/MultiplierTag";
import { ProviderIcon } from "../shared/provider-icon";
import { ModelSelectorTrigger } from "./ModelSelectorTrigger";

/**
 * 模型选择器的视图层：搜索、按 provider 分组、推理档位子菜单、云端/默认/视觉徽章。
 *
 * 纯展示——模型从哪来、选中后写到哪、文案怎么翻译，全部由调用方通过 props 决定。
 * 宿主的输入栏用它，插件（看板等）经 `@vetta-org/theme-ui/plugin-ui` 用的也是同一个，
 * 两边因此不会长成两副样子。
 */

/** 选择器需要的模型字段；宿主的 ModelOption 结构上即满足它。 */
export interface ModelSelectorOptionView {
	/** `provider/modelId`。 */
	readonly key: string;
	readonly provider: string;
	readonly modelId: string;
	readonly displayName: string;
	/** 副文本（如模型 ID）：仅在宿主给出时以灰色等宽小号显示。 */
	readonly subtitle?: string;
	/** 参与搜索匹配的附加标签。 */
	readonly tags?: readonly string[];
	/** 来自远程目录（云端）；分组头会打上 `labels.cloudOnly` 徽章。 */
	readonly remote?: boolean;
	readonly supportsImage?: boolean;
	/** 模型厂商显示名。宿主已按厂商排好序；有值时在厂商变化处插入分区头。 */
	readonly vendor?: string;
	/** 厂商稳定 id；分区头带 `data-vendor-id` 供快捷条滚动定位。 */
	readonly vendorId?: string;
	/** 厂商 logo URL。 */
	readonly vendorIcon?: string;
	/** 单色 logo，暗色下反色显示。 */
	readonly vendorMono?: boolean;
	/** 近期发布，显示 `labels.newBadge`。 */
	readonly isNew?: boolean;
}

export interface ModelSelectorLabels {
	placeholder: string;
	searchPlaceholder: string;
	clearSearch: string;
	noResults: string;
	noResultsHint: string;
	reasoningHeader: string;
	modelHeader: string;
	cloudOnly: string;
	visionBadge: string;
	defaultBadge: string;
	/** 近期发布模型的徽标文案；未提供则不显示。 */
	newBadge?: string;
	unavailableBadge?: string;
	unavailableHint?: string;
	syncCatalog?: string;
	cached?: string;
	fallback?: string;
	refreshFailed?: string;
	/** 厂商快捷条里「回到顶部」chip 的文案。 */
	allVendors?: string;
	/** 推荐卡上「已选用当前模型」的文案。 */
	recommendationSelected?: string;
	/** 推荐卡上「点击选用」的文案。 */
	recommendationAction?: string;
	levelLabel: (value: string) => string;
	/**
	 * 计费倍率标（如「2×」「免费」）。返回空/undefined 则不渲染——倍率含义与文案属于
	 * 宿主的计费口径，视图不猜。
	 */
	multiplierLabel?: (option: ModelSelectorOptionView) => string | undefined;
}

export interface ModelSelectorProviderGroup {
	provider: string;
	label: string;
	icon?: string;
	models: readonly ModelSelectorOptionView[];
}

/** 分组标签页（如「智能 / 普通 / 官方 / 全部」）。宿主给定时才渲染分段控件。 */
export interface ModelSelectorTab {
	id: string;
	label: string;
	/** solar icon class，如 `icon-[solar--bolt-linear]`；空则不画图标。 */
	icon?: string;
	/** 属于该 tab 的 provider id；空数组表示展示全部 provider。 */
	providers: readonly string[];
	modelCount?: number;
}

/** 厂商快捷条 chip：点击滚动到对应 `data-vendor-id` 分区，不做筛选。 */
export interface ModelSelectorVendorChip {
	id: string;
	name: string;
	iconUrl?: string;
	mono?: boolean;
	count?: number;
}

/** 推荐卡（如智能组的推荐模型）：宿主给文案，视图只负责渲染。 */
export interface ModelSelectorHighlight {
	/** 只在 activeTab === tabId 时显示。 */
	tabId: string;
	title: string;
	badge?: string;
	description?: string;
	/** 点击卡片要选中的模型 key；也用于「已选用」判定。 */
	modelKey?: string;
}

/** 触发按钮上的小徽标（如分组名）。 */
export interface ModelSelectorTriggerBadge {
	text: string;
	tone: "primary" | "blue" | "amber";
}

export interface ModelSelectorViewProps {
	selectedModel?: string;
	selectedUnavailable?: boolean;
	selectedOption: ModelSelectorOptionView | null;
	currentLevel?: string;
	menuLevels: string[];
	groups: readonly ModelSelectorProviderGroup[];
	defaultKey?: string;
	labels: ModelSelectorLabels;
	/** 分组标签页；缺省不渲染 tab 栏（平铺所有 provider 组）。 */
	tabs?: readonly ModelSelectorTab[];
	/** 打开菜单时默认激活的 tab id。 */
	initialTab?: string;
	/** 每个 tab 的厂商快捷条（顺序由宿主决定）。 */
	vendorBarByTab?: Readonly<Record<string, readonly ModelSelectorVendorChip[]>>;
	/** 推荐卡；仅在对应 tab 且未搜索时显示。 */
	highlight?: ModelSelectorHighlight;
	highlightByTab?: Readonly<Record<string, ModelSelectorHighlight>>;
	/** 触发按钮上的分组徽标。 */
	triggerBadge?: ModelSelectorTriggerBadge;
	ariaLabel?: string;
	disabled?: boolean;
	/** 可选的空值项，例如“不固定模型”或“跟随会话默认”。 */
	emptyOption?: {
		readonly label: string;
		readonly onSelect: () => void;
	};
	className?: string;
	classNames?: {
		trigger?: string;
		content?: string;
		contentInner?: string;
		providerHeader?: string;
		item?: string;
	};
	onModelSelect: (key: string) => void;
	onReasoningSelect: (value: string) => void;
	/** 菜单开合回调，宿主可借此在打开时刷新模型目录 */
	onOpenChange?: (open: boolean) => void;
	onCatalogRefresh?: () => Promise<void>;
	catalogStatus?: "network" | "cache" | "fallback";
}

const MODEL_ITEM_SELECTOR = "[data-model-key]";

/** 紧凑行：覆盖 @vetta-org/ui 默认的 px-3 py-2 text-[13px]，让模型多时列表不至于过长。 */
const COMPACT_ITEM_CLASS = "gap-2 rounded-lg px-2.5 py-1.5 text-[12px]";
const COMPACT_LABEL_CLASS = "px-2 pb-0.5 pt-1 text-[10px]";

function normalizeSearchValue(value: string): string {
	return value.trim().toLocaleLowerCase();
}

export function ModelSelectorView({
	selectedModel,
	selectedUnavailable = false,
	selectedOption,
	currentLevel,
	menuLevels,
	groups,
	defaultKey,
	labels,
	tabs,
	initialTab,
	vendorBarByTab,
	highlight,
	highlightByTab,
	triggerBadge,
	ariaLabel,
	disabled = false,
	emptyOption,
	className,
	classNames,
	onModelSelect,
	onReasoningSelect,
	onOpenChange,
	onCatalogRefresh,
	catalogStatus,
}: ModelSelectorViewProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeVendor, setActiveVendor] = useState<string | null>(null);
	const [catalogRefreshing, setCatalogRefreshing] = useState(false);
	const [catalogRefreshFailed, setCatalogRefreshFailed] = useState(false);
	const refreshBusyRef = useRef(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const modelListRef = useRef<HTMLElement>(null);
	const initialFrameRef = useRef<number | null>(null);
	const cancelInitialFrame = useCallback(() => {
		if (initialFrameRef.current !== null) cancelAnimationFrame(initialFrameRef.current);
		initialFrameRef.current = null;
	}, []);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const portalContainer = open
		? (triggerRef.current?.closest<HTMLElement>('[data-slot="drawer-content"], [data-slot="dialog-content"]') ??
			undefined)
		: undefined;

	const preferredTab = tabs?.find((tab) => tab.id === initialTab)?.id ?? tabs?.[0]?.id ?? initialTab ?? "all";
	const [activeTab, setActiveTab] = useState<string>(preferredTab);

	const previousSelection = useRef({ open: false, selectedModel });
	useEffect(() => {
		const previous = previousSelection.current;
		if (open && (!previous.open || previous.selectedModel !== selectedModel)) {
			setActiveTab(preferredTab);
			setActiveVendor(null);
		}
		previousSelection.current = { open, selectedModel };
	}, [open, selectedModel, preferredTab]);

	useEffect(() => {
		if (!open || !tabs?.length || tabs.some((tab) => tab.id === activeTab)) return;
		setActiveTab(preferredTab);
		setActiveVendor(null);
	}, [open, tabs, activeTab, preferredTab]);

	useEffect(() => {
		if (!open) return;
		if (modelListRef.current) modelListRef.current.scrollTop = 0;
		setActiveVendor(null);
	}, [open, activeTab]);

	const activeTabProviders = useMemo(
		() => (tabs ? (tabs.find((tab) => tab.id === activeTab)?.providers ?? []) : []),
		[tabs, activeTab],
	);

	const filteredGroups = useMemo(() => {
		let currentGroups = groups;
		if (tabs && activeTabProviders.length > 0) {
			currentGroups = groups.filter((g) => activeTabProviders.includes(g.provider));
		}

		const query = normalizeSearchValue(searchQuery);
		if (!query) return currentGroups.filter((group) => group.models.length > 0);

		return currentGroups.flatMap((group) => {
			const models = group.models.filter((model) =>
				[
					model.displayName,
					model.subtitle,
					model.modelId,
					model.provider,
					model.vendor,
					model.vendorId,
					group.label,
					...(model.tags ?? []),
				].some((value) => value && normalizeSearchValue(value).includes(query)),
			);
			return models.length > 0 ? [{ ...group, models }] : [];
		});
	}, [groups, tabs, activeTab, activeTabProviders, searchQuery]);

	/** 当前 tab 的厂商快捷条（顺序由宿主给定）。 */
	const vendorChips = useMemo(
		() => (vendorBarByTab && Object.hasOwn(vendorBarByTab, activeTab) ? vendorBarByTab[activeTab] : []),
		[vendorBarByTab, activeTab],
	);

	const scrollListToTop = useCallback(() => {
		cancelInitialFrame();
		if (modelListRef.current) modelListRef.current.scrollTop = 0;
		setActiveVendor(null);
	}, [cancelInitialFrame]);

	const scrollToVendor = useCallback(
		(vendorId: string) => {
			cancelInitialFrame();
			const target = Array.from(
				modelListRef.current?.querySelectorAll<HTMLElement>("[data-model-vendor-section]") ?? [],
			).find((section) => section.dataset.vendorId === vendorId);
			target?.scrollIntoView({ block: "start" });
			setActiveVendor(vendorId);
		},
		[cancelInitialFrame],
	);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			setOpen(nextOpen);
			if (!nextOpen) {
				setReasoningOpen(false);
				setSearchQuery("");
			}
			onOpenChange?.(nextOpen);
		},
		[onOpenChange],
	);

	useEffect(() => {
		if (!open) return;

		const frame = requestAnimationFrame(() => {
			if (initialFrameRef.current !== frame) return;
			initialFrameRef.current = null;
			searchInputRef.current?.focus();
			if (!selectedModel) return;
			const selectedItem = Array.from(
				modelListRef.current?.querySelectorAll<HTMLElement>(MODEL_ITEM_SELECTOR) ?? [],
			).find((item) => item.dataset.modelKey === selectedModel);
			selectedItem?.scrollIntoView({ block: "nearest" });
		});

		initialFrameRef.current = frame;
		return cancelInitialFrame;
	}, [open, selectedModel, cancelInitialFrame]);

	const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
		cancelInitialFrame();
		setSearchQuery(event.target.value);
	};

	const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") return;
		cancelInitialFrame();
		event.stopPropagation();

		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const items = Array.from(modelListRef.current?.querySelectorAll<HTMLElement>(MODEL_ITEM_SELECTOR) ?? []);
		const target = event.key === "ArrowDown" ? items[0] : items[items.length - 1];
		if (!target) return;
		event.preventDefault();
		target.focus();
	};

	const handleSearchClick = (event: ReactMouseEvent<HTMLInputElement | HTMLButtonElement>) => {
		cancelInitialFrame();
		event.stopPropagation();
	};

	const handleClearSearch = (event: ReactMouseEvent<HTMLButtonElement>) => {
		cancelInitialFrame();
		event.stopPropagation();
		setSearchQuery("");
		searchInputRef.current?.focus();
	};

	const handleModelSelect = (key: string) => {
		cancelInitialFrame();
		onModelSelect(key);
		setSearchQuery("");
	};
	const handleControlKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		cancelInitialFrame();
		if (event.key === "Tab") event.stopPropagation();
	};
	const activeHighlight =
		(highlightByTab && Object.hasOwn(highlightByTab, activeTab) ? highlightByTab[activeTab] : undefined) ??
		(highlight?.tabId === activeTab ? highlight : undefined);
	const refreshHint = catalogRefreshFailed
		? labels.refreshFailed
		: catalogStatus === "cache"
			? labels.cached
			: catalogStatus === "fallback"
				? labels.fallback
				: undefined;
	const handleCatalogRefresh = async () => {
		if (!onCatalogRefresh || refreshBusyRef.current) return;
		cancelInitialFrame();
		refreshBusyRef.current = true;
		setCatalogRefreshing(true);
		setCatalogRefreshFailed(false);
		try {
			await onCatalogRefresh();
		} catch {
			setCatalogRefreshFailed(true);
		} finally {
			refreshBusyRef.current = false;
			setCatalogRefreshing(false);
		}
	};
	const highlightSelectable = Boolean(
		activeHighlight?.modelKey &&
			filteredGroups.some((group) => group.models.some((model) => model.key === activeHighlight.modelKey)),
	);
	const triggerLabel =
		selectedOption?.displayName ??
		(selectedUnavailable && selectedModel ? selectedModel.slice(selectedModel.indexOf("/") + 1) : labels.placeholder);

	return (
		<DropdownMenu open={open} modal={false} onOpenChange={handleOpenChange}>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<ModelSelectorTrigger
					ref={triggerRef}
					aria-label={ariaLabel}
					disabled={disabled}
					label={triggerLabel}
					icon={
						selectedOption ? groups.find((group) => group.provider === selectedOption.provider)?.icon : undefined
					}
					badge={triggerBadge}
					reasoningLabel={currentLevel ? labels.levelLabel(currentLevel) : undefined}
					unavailable={selectedUnavailable}
					unavailableBadge={labels.unavailableBadge}
					unavailableHint={labels.unavailableHint}
					className={cn(className, classNames?.trigger)}
				/>
			</DropdownMenuTrigger>
			<AnimatePresence>
				{open && (
					<DropdownMenuContent
						forceMount
						asChild
						portalContainer={portalContainer}
						align="start"
						collisionPadding={12}
						className={cn(
							"w-[400px] min-w-0 max-h-[440px] max-w-[calc(100vw-24px)] overflow-visible bg-popover p-0 shadow-md",
							classNames?.content,
						)}
						style={{ animation: "none" }}
					>
						<motion.div
							initial={{ opacity: 0, y: 4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 4 }}
							transition={{ duration: 0.1 }}
						>
							<div className="relative overflow-visible rounded-[inherit]">
								<ThemeSurface slot="chat.modelSelectorMenu" />
								<div
									className={cn(
										"relative z-10 flex max-h-[min(438px,calc(var(--radix-dropdown-menu-content-available-height,440px)-2px))] flex-col overflow-hidden rounded-[inherit] p-1",
										classNames?.contentInner,
									)}
								>
									{tabs && tabs.length > 0 && (
										<nav
											aria-label={labels.modelHeader}
											className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/40 p-1"
										>
											{tabs.map((tab) => (
												<Button
													onKeyDown={handleControlKeyDown}
													key={tab.id}
													type="button"
													variant="ghost"
													size="sm"
													title={tab.label}
													aria-current={activeTab === tab.id ? "page" : undefined}
													onClick={() => {
														setActiveTab(tab.id);
														scrollListToTop();
													}}
													className={cn(
														"h-7 min-w-0 max-w-[10rem] shrink-0 gap-1.5 rounded-full px-2.5 text-[11px] transition-colors",
														activeTab === tab.id ? "bg-primary/10 text-primary" : "text-muted-foreground",
													)}
												>
													{tab.icon ? (
														<span aria-hidden="true" className={cn(tab.icon, "size-3 shrink-0")} />
													) : null}
													<span className="truncate">{tab.label}</span>
													{tab.modelCount !== undefined ? (
														<span
															aria-hidden="true"
															className="text-[10px] tabular-nums text-muted-foreground"
														>
															{tab.modelCount}
														</span>
													) : null}
												</Button>
											))}
										</nav>
									)}
									<div className="relative shrink-0 p-1">
										<span
											aria-hidden="true"
											className="icon-[solar--magnifer-linear] pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
										/>
										<input
											ref={searchInputRef}
											type="search"
											value={searchQuery}
											onKeyDown={handleSearchKeyDown}
											onChange={handleSearchChange}
											onClick={handleSearchClick}
											placeholder={labels.searchPlaceholder}
											aria-label={labels.searchPlaceholder}
											className={cn(
												"h-8 w-full rounded-lg bg-muted/40 pl-7 pr-8 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
												onCatalogRefresh && searchQuery && "pr-16",
											)}
										/>
										<div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
											{searchQuery ? (
												<Button
													onKeyDown={handleControlKeyDown}
													type="button"
													variant="ghost"
													size="icon-xs"
													onClick={handleClearSearch}
													aria-label={labels.clearSearch}
													className="transition-colors"
												>
													<span
														aria-hidden="true"
														className="icon-[solar--close-circle-linear] size-3.5"
													/>
												</Button>
											) : null}
											{onCatalogRefresh ? (
												<Button
													onKeyDown={handleControlKeyDown}
													type="button"
													variant="ghost"
													size="icon-xs"
													onClick={() => {
														void handleCatalogRefresh();
													}}
													disabled={catalogRefreshing}
													aria-busy={catalogRefreshing}
													aria-label={labels.syncCatalog ?? labels.modelHeader}
													title={[labels.syncCatalog, refreshHint].filter(Boolean).join("\n")}
													className="transition-colors"
												>
													<span
														aria-hidden="true"
														className={cn(
															"icon-[solar--refresh-linear] size-3.5",
															catalogRefreshing && "animate-spin",
														)}
													/>
												</Button>
											) : null}
											{catalogRefreshFailed && labels.refreshFailed ? (
												<output className="sr-only">{labels.refreshFailed}</output>
											) : null}
										</div>
									</div>
									{activeHighlight && !searchQuery && (
										<div className="shrink-0 px-1 pb-1">
											<Button
												onKeyDown={handleControlKeyDown}
												type="button"
												variant="ghost"
												disabled={!highlightSelectable}
												title={activeHighlight.description ?? activeHighlight.title}
												onClick={() => {
													if (activeHighlight.modelKey) handleModelSelect(activeHighlight.modelKey);
												}}
												className="h-auto w-full min-w-0 justify-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-2.5 py-1.5 text-left transition-colors"
											>
												<span
													aria-hidden="true"
													className="icon-[solar--star-linear] size-3.5 shrink-0 text-primary"
												/>
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[12px] font-medium text-foreground">
														{activeHighlight.title}
													</span>
													{activeHighlight.description ? (
														<span className="block truncate text-[10px] font-normal text-muted-foreground">
															{activeHighlight.description}
														</span>
													) : null}
												</span>
												{activeHighlight.badge ? (
													<span className="max-w-20 truncate text-[10px] font-medium text-primary">
														{activeHighlight.badge}
													</span>
												) : null}
												<span className="shrink-0 text-[10px] font-normal text-muted-foreground">
													{selectedModel === activeHighlight.modelKey
														? labels.recommendationSelected
														: labels.recommendationAction}
												</span>
											</Button>
										</div>
									)}
									{vendorChips.length > 0 && (
										<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-1 pb-1 text-[10px]">
											<Button
												onKeyDown={handleControlKeyDown}
												type="button"
												variant="ghost"
												size="xs"
												aria-pressed={activeVendor === null}
												onClick={scrollListToTop}
												className={cn(
													"h-6 shrink-0 rounded-full px-2 text-[10px] transition-colors",
													activeVendor === null && "bg-accent text-foreground",
												)}
											>
												{labels.allVendors ?? labels.modelHeader}
											</Button>
											{vendorChips.map((chip) => (
												<Button
													onKeyDown={handleControlKeyDown}
													key={chip.id}
													type="button"
													variant="ghost"
													size="xs"
													title={chip.name}
													aria-pressed={activeVendor === chip.id}
													onClick={() => scrollToVendor(chip.id)}
													className={cn(
														"h-6 max-w-[10rem] shrink-0 gap-1.5 rounded-full px-2 text-[10px] transition-colors",
														activeVendor === chip.id && "bg-accent text-foreground",
													)}
												>
													<VendorIcon
														name={chip.name}
														iconUrl={chip.iconUrl}
														mono={chip.mono}
														className="size-3.5"
													/>
													<span className="truncate">{chip.name}</span>
													{chip.count !== undefined ? (
														<span
															aria-hidden="true"
															className="text-[10px] tabular-nums text-muted-foreground"
														>
															{chip.count}
														</span>
													) : null}
												</Button>
											))}
										</div>
									)}
									{menuLevels.length > 0 && (
										<>
											<DropdownMenuSub open={reasoningOpen} onOpenChange={setReasoningOpen}>
												<DropdownMenuSubTrigger
													className={cn(COMPACT_ITEM_CLASS, "w-fit max-w-[calc(100%-144px)]")}
													onPointerMove={cancelInitialFrame}
													onPointerDown={cancelInitialFrame}
													onKeyDown={cancelInitialFrame}
												>
													<span className="min-w-0 flex-1 truncate">{labels.reasoningHeader}</span>
													{currentLevel ? (
														<span className="text-[11px] text-muted-foreground">
															{labels.levelLabel(currentLevel)}
														</span>
													) : null}
												</DropdownMenuSubTrigger>
												<AnimatePresence>
													{reasoningOpen ? (
														<DropdownMenuSubContent
															forceMount
															portalContainer={portalContainer}
															collisionPadding={12}
															className="min-w-[130px] overflow-visible bg-popover p-0"
															style={{ animation: "none" }}
														>
															<motion.div
																initial={{ opacity: 0 }}
																animate={{ opacity: 1 }}
																exit={{ opacity: 0 }}
																transition={{ duration: 0.1 }}
															>
																<div className="relative overflow-hidden rounded-[inherit]">
																	<ThemeSurface slot="chat.modelSelectorReasoningMenu" />
																	<div className="relative z-10 p-1">
																		<DropdownMenuLabel className={COMPACT_LABEL_CLASS}>
																			{labels.reasoningHeader}
																		</DropdownMenuLabel>
																		{menuLevels.map((level) => (
																			<DropdownMenuItem
																				key={level}
																				className={COMPACT_ITEM_CLASS}
																				onSelect={() => onReasoningSelect(level)}
																			>
																				<span className="min-w-0 flex-1 truncate">
																					{labels.levelLabel(level)}
																				</span>
																				{level === currentLevel ? (
																					<span
																						aria-hidden="true"
																						className="icon-[solar--check-circle-linear] size-3 shrink-0"
																					/>
																				) : null}
																			</DropdownMenuItem>
																		))}
																	</div>
																</div>
															</motion.div>
														</DropdownMenuSubContent>
													) : null}
												</AnimatePresence>
											</DropdownMenuSub>
											<DropdownMenuSeparator />
										</>
									)}
									<section
										ref={modelListRef}
										aria-label={labels.modelHeader}
										className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
									>
										{emptyOption ? (
											<>
												<DropdownMenuItem
													aria-current={!selectedModel ? "true" : undefined}
													className={COMPACT_ITEM_CLASS}
													onSelect={emptyOption.onSelect}
												>
													<span className="min-w-0 flex-1 truncate">{emptyOption.label}</span>
													{!selectedModel ? (
														<span
															aria-hidden="true"
															className="icon-[solar--check-circle-linear] size-3 shrink-0"
														/>
													) : null}
												</DropdownMenuItem>
												<DropdownMenuSeparator />
											</>
										) : null}
										{!tabs?.length ? (
											<DropdownMenuLabel className={COMPACT_LABEL_CLASS}>
												{labels.modelHeader}
											</DropdownMenuLabel>
										) : null}
										{filteredGroups.map((group) => (
											<div key={group.provider}>
												{!tabs?.length ||
												filteredGroups.length > 1 ||
												group.models.some((model) => model.remote) ? (
													<div
														className={cn(
															"flex min-w-0 items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium text-muted-foreground",
															classNames?.providerHeader,
														)}
													>
														<ProviderIcon symbol={group.icon} className="size-3" />
														<span className="truncate">{group.label}</span>
														{group.models.some((model) => model.remote) ? (
															<span className="shrink-0 text-[10px] text-muted-foreground">
																{labels.cloudOnly}
															</span>
														) : null}
													</div>
												) : null}
												{vendorSegments(group.models).map((segment) => (
													<div key={segment.key}>
														{segment.vendor ? (
															<div
																data-model-vendor-section=""
																data-vendor-id={segment.vendorId}
																className="sticky top-0 z-10 flex min-w-0 items-center gap-1.5 border-b border-border/30 bg-popover px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground"
															>
																<VendorIcon
																	name={segment.vendor}
																	iconUrl={segment.vendorIcon}
																	mono={segment.vendorMono}
																	className="size-3.5"
																/>
																<span className="min-w-0 truncate">{segment.vendor}</span>
																<span className="ml-auto tabular-nums">{segment.models.length}</span>
															</div>
														) : null}
														{segment.models.map((model) => (
															<DropdownMenuItem
																key={model.key}
																data-model-key={model.key}
																onPointerMove={cancelInitialFrame}
																onPointerDown={cancelInitialFrame}
																aria-current={model.key === selectedModel ? "true" : undefined}
																title={[model.displayName, model.subtitle, ...(model.tags ?? [])]
																	.filter(Boolean)
																	.join("\n")}
																className={cn(
																	COMPACT_ITEM_CLASS,
																	model.key === selectedModel && "bg-accent text-accent-foreground",
																	classNames?.item,
																)}
																onSelect={() => handleModelSelect(model.key)}
															>
																<span className="min-w-0 flex-1">
																	<span className="block truncate font-medium leading-4">
																		{model.displayName}
																	</span>
																	{model.subtitle &&
																	normalizeSearchValue(model.subtitle) !==
																		normalizeSearchValue(model.displayName) ? (
																		<span className="block truncate font-mono text-[10px] leading-4 text-muted-foreground">
																			{model.subtitle}
																		</span>
																	) : null}
																</span>
																{model.supportsImage ? (
																	<span
																		role="img"
																		aria-label={labels.visionBadge}
																		title={labels.visionBadge}
																		className="icon-[solar--gallery-linear] size-3 shrink-0 text-muted-foreground"
																	/>
																) : null}
																{model.isNew && labels.newBadge ? (
																	<span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
																		{labels.newBadge}
																	</span>
																) : null}
																{model.key === defaultKey ? (
																	<span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
																		{labels.defaultBadge}
																	</span>
																) : null}
																<ModelMultiplier label={labels.multiplierLabel?.(model)} />
																{model.key === selectedModel ? (
																	<span
																		aria-hidden="true"
																		className="icon-[solar--check-circle-linear] size-3 shrink-0 text-primary"
																	/>
																) : null}
															</DropdownMenuItem>
														))}
													</div>
												))}
											</div>
										))}
										{filteredGroups.length === 0 ? (
											<div className="flex min-h-24 flex-col items-center justify-center px-4 py-6 text-center">
												<p className="text-[12px] font-medium">{labels.noResults}</p>
												<p className="mt-1 text-[11px] text-muted-foreground">{labels.noResultsHint}</p>
											</div>
										) : null}
									</section>
								</div>
							</div>
						</motion.div>
					</DropdownMenuContent>
				)}
			</AnimatePresence>
		</DropdownMenu>
	);
}

function ModelMultiplier({ label }: { label?: string }): JSX.Element | null {
	return label ? <MultiplierTag text={label} /> : null;
}

interface VendorSegment {
	key: string;
	vendor?: string;
	vendorId?: string;
	vendorIcon?: string;
	vendorMono?: boolean;
	models: ModelSelectorOptionView[];
}

/** Split a provider's already-sorted models into vendor segments (for sticky section headers). */
function vendorSegments(models: readonly ModelSelectorOptionView[]): VendorSegment[] {
	const segments: VendorSegment[] = [];
	for (const model of models) {
		const key = model.vendorId ?? model.vendor;
		const last = segments[segments.length - 1];
		if (!key || !last || last.key !== key) {
			segments.push({
				key: key ?? `plain-${segments.length}`,
				vendor: model.vendor,
				vendorId: model.vendorId,
				vendorIcon: model.vendorIcon,
				vendorMono: model.vendorMono,
				models: [model],
			});
		} else {
			last.models.push(model);
		}
	}
	return segments;
}

/** 厂商 logo；无 logo 时退化为首字母圆标。 */
function VendorIcon({
	name,
	iconUrl,
	mono,
	className,
}: {
	name: string;
	iconUrl?: string;
	mono?: boolean;
	className?: string;
}): JSX.Element {
	if (!iconUrl) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold uppercase text-muted-foreground",
					className,
				)}
			>
				{name.slice(0, 1)}
			</span>
		);
	}
	return (
		<img
			src={iconUrl}
			alt=""
			aria-hidden="true"
			loading="lazy"
			className={cn("shrink-0 object-contain", mono && "dark:invert", className)}
		/>
	);
}
