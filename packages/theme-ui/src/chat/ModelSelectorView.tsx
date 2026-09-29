import { AnimatePresence, motion } from "motion/react";
import type { ChangeEvent, JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	cn,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@vetta-org/ui";
import { ThemeSurface } from "../appearance/ThemeSurface";
import { MultiplierTag } from "../shared/MultiplierTag";
import { ProviderIcon } from "../shared/provider-icon";

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
	/** 触发按钮上的分组徽标。 */
	triggerBadge?: ModelSelectorTriggerBadge;
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
}

const MODEL_ITEM_SELECTOR = "[data-model-key]";

/** 紧凑行：覆盖 @vetta-org/ui 默认的 px-3 py-2 text-[13px]，让模型多时列表不至于过长。 */
const COMPACT_ITEM_CLASS = "gap-1.5 rounded-md px-2 py-1 text-xs";
const COMPACT_LABEL_CLASS = "px-2 pb-0.5 pt-1 text-[10px]";

function normalizeSearchValue(value: string): string {
	return value.trim().toLocaleLowerCase();
}

export function ModelSelectorView({
	selectedModel,
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
	triggerBadge,
	className,
	classNames,
	onModelSelect,
	onReasoningSelect,
	onOpenChange,
}: ModelSelectorViewProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [activeVendor, setActiveVendor] = useState<string | null>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const modelListRef = useRef<HTMLDivElement>(null);

	const preferredTab = tabs?.find((tab) => tab.id === initialTab)?.id ?? tabs?.[0]?.id ?? initialTab ?? "all";
	const [activeTab, setActiveTab] = useState<string>(preferredTab);

	useEffect(() => {
		if (!open) return;
		setActiveTab(preferredTab);
		setActiveVendor(null);
	}, [open, preferredTab]);

	useEffect(() => {
		if (!open || !tabs?.length || tabs.some((tab) => tab.id === activeTab)) return;
		setActiveTab(preferredTab);
		setActiveVendor(null);
	}, [open, tabs, activeTab, preferredTab]);

	const activeTabProviders = useMemo(
		() => (tabs ? (tabs.find((tab) => tab.id === activeTab)?.providers ?? []) : []),
		[tabs, activeTab],
	);

	const filteredGroups = useMemo(() => {
		let currentGroups = groups;
		if (tabs && activeTab !== "all" && activeTabProviders.length > 0) {
			currentGroups = groups.filter((g) => activeTabProviders.includes(g.provider));
		}

		const query = normalizeSearchValue(searchQuery);
		if (!query) return currentGroups;

		return currentGroups.flatMap((group) => {
			const models = group.models.filter((model) =>
				[
					model.displayName,
					model.subtitle,
					model.modelId,
					model.provider,
					group.label,
					...(model.tags ?? []),
				].some((value) => value && normalizeSearchValue(value).includes(query)),
			);
			return models.length > 0 ? [{ ...group, models }] : [];
		});
	}, [groups, tabs, activeTab, activeTabProviders, searchQuery]);

	/** 当前 tab 的厂商快捷条（顺序由宿主给定）。 */
	const vendorChips = useMemo(() => vendorBarByTab?.[activeTab] ?? [], [vendorBarByTab, activeTab]);

	const scrollListToTop = useCallback(() => {
		modelListRef.current?.scrollTo({ top: 0 });
		setActiveVendor(null);
	}, []);

	const scrollToVendor = useCallback((vendorId: string) => {
		const target = modelListRef.current?.querySelector<HTMLElement>(`[data-vendor-id="${vendorId}"]`);
		target?.scrollIntoView({ block: "start" });
		setActiveVendor(vendorId);
	}, []);

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
			searchInputRef.current?.focus();
			if (!selectedModel) return;
			const selectedItem = Array.from(
				modelListRef.current?.querySelectorAll<HTMLElement>(MODEL_ITEM_SELECTOR) ?? [],
			).find((item) => item.dataset.modelKey === selectedModel);
			selectedItem?.scrollIntoView({ block: "nearest" });
		});

		return () => cancelAnimationFrame(frame);
	}, [open, selectedModel]);

	const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(event.target.value);
	};

	const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") return;
		event.stopPropagation();

		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const items = Array.from(modelListRef.current?.querySelectorAll<HTMLElement>(MODEL_ITEM_SELECTOR) ?? []);
		const target = event.key === "ArrowDown" ? items[0] : items[items.length - 1];
		if (!target) return;
		event.preventDefault();
		target.focus();
	};

	const handleSearchClick = (event: ReactMouseEvent<HTMLInputElement | HTMLButtonElement>) => {
		event.stopPropagation();
	};

	const handleClearSearch = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		setSearchQuery("");
		searchInputRef.current?.focus();
	};

	const handleModelSelect = (key: string) => {
		onModelSelect(key);
		setSearchQuery("");
	};

	return (
		// 搜索型选择器不需要锁住页面；modal 模式会改写 body 的滚动与 pointer-events，
		// 在长会话页面触发整棵 DOM 的同步样式重算。
		<DropdownMenu open={open} modal={false} onOpenChange={handleOpenChange}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					title={selectedOption?.displayName ?? labels.placeholder}
					className={cn(
						// 输入卡 @container：窄宽缩短模型名、藏推理档，避免工具栏换行
						"flex min-w-0 max-w-[6.5rem] items-center gap-1 rounded-full border border-transparent px-1.5 py-0.5 text-[11px] text-foreground transition-colors focus:outline-none focus-visible:outline-none data-[state=open]:bg-accent/60 data-[state=open]:text-foreground @[22rem]:max-w-[10rem] @[28rem]:max-w-[14rem]",
						className,
						classNames?.trigger,
					)}
				>
					{triggerBadge ? (
						<span
							className={cn(
								"shrink-0 rounded px-1 text-[9px] font-semibold leading-[14px]",
								triggerBadge.tone === "primary" && "bg-primary/20 text-primary font-bold",
								triggerBadge.tone === "blue" && "bg-blue-500/15 text-blue-600 dark:text-blue-400",
								triggerBadge.tone === "amber" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
							)}
						>
							{triggerBadge.text}
						</span>
					) : selectedOption ? (
						<ProviderIcon
							symbol={groups.find((g) => g.provider === selectedOption.provider)?.icon}
							className="h-3 w-3 shrink-0"
						/>
					) : null}
					<span className="min-w-0 flex-1 truncate text-left font-medium">
						{selectedOption?.displayName ?? labels.placeholder}
					</span>
					{currentLevel && (
						<span className="hidden shrink-0 rounded bg-muted/70 px-1 text-[9px] leading-[14px] text-muted-foreground @[28rem]:inline">
							{labels.levelLabel(currentLevel)}
						</span>
					)}
					<span className="icon-[solar--alt-arrow-down-linear] h-2.5 w-2.5 shrink-0 text-muted-foreground" />
				</button>
			</DropdownMenuTrigger>
			<AnimatePresence>
				{open && (
					<DropdownMenuContent
						forceMount
						asChild
						align="start"
						className={cn(
							"w-[min(24rem,calc(100vw-2rem))] min-w-[260px] max-w-[24rem] overflow-visible bg-background p-0 shadow-lg",
							classNames?.content,
						)}
						style={{ animation: "none" }}
					>
						<motion.div
							initial={{ opacity: 0, scale: 0.96, y: 8 }}
							animate={{ opacity: 1, scale: 1, y: 0 }}
							exit={{ opacity: 0, scale: 0.96, y: 8 }}
							transition={{ duration: 0.1, ease: [0.16, 1, 0.3, 1] }}
						>
							<div className="relative overflow-visible rounded-[inherit]">
								<ThemeSurface slot="chat.modelSelectorMenu" />
								<div
									className={cn(
										"relative z-10 flex max-h-[min(400px,65vh)] flex-col overflow-hidden rounded-[inherit] p-1",
										classNames?.contentInner,
									)}
								>
									{/* 分组标签页（宿主提供 tabs 时才渲染） */}
									{tabs && tabs.length > 0 && (
										<div className="shrink-0 p-1 border-b border-border/40">
											<div
												className={cn(
													"grid gap-1 rounded-lg bg-muted/60 p-0.5 text-[11px]",
													tabs.length === 4 ? "grid-cols-4" : "grid-cols-3",
												)}
											>
												{tabs.map((tab) => (
													<button
														key={tab.id}
														type="button"
														onClick={() => {
															setActiveTab(tab.id);
															setActiveVendor(null);
															if (tab.id === "all") scrollListToTop();
														}}
														className={cn(
															"flex items-center justify-center gap-1 rounded-md px-1.5 py-1 font-medium transition-all",
															activeTab === tab.id
																? "bg-background text-primary shadow-sm font-semibold"
																: "text-muted-foreground hover:text-foreground",
														)}
													>
														{tab.icon && <span className={cn(tab.icon, "size-3 shrink-0")} />}
														{tab.label}
													</button>
												))}
											</div>
										</div>
									)}

									{/* 厂商快捷条：点击滚动到对应分区，不做筛选 */}
									{vendorChips.length > 0 && (
										<div className="shrink-0 flex items-center gap-1 overflow-x-auto px-1.5 pt-1.5 pb-0.5 text-[10px] no-scrollbar">
											<button
												type="button"
												aria-pressed={activeVendor === null}
												onClick={scrollListToTop}
												className={cn(
													"shrink-0 rounded-full px-2 py-0.5 text-[10px] transition-colors",
													activeVendor === null
														? "bg-primary/20 font-semibold text-primary"
														: "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
												)}
											>
												{labels.allVendors ?? "All"}
											</button>
											{vendorChips.map((chip) => (
												<button
													key={chip.id}
													type="button"
													aria-pressed={activeVendor === chip.id}
													onClick={() => scrollToVendor(chip.id)}
													className={cn(
														"flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-colors",
														activeVendor === chip.id
															? "bg-primary/20 font-semibold text-primary"
															: "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
													)}
												>
													<VendorIcon name={chip.name} iconUrl={chip.iconUrl} mono={chip.mono} className="size-4" />
													{chip.name}
												</button>
											))}
										</div>
									)}

									{/* 推荐卡（宿主提供 highlight，只在对应 tab 显示） */}
									{highlight && activeTab === highlight.tabId && !searchQuery && (
										<div className="shrink-0 p-1.5">
											<div
												onClick={() => {
													if (highlight.modelKey) handleModelSelect(highlight.modelKey);
												}}
												className="group flex cursor-pointer flex-col gap-1 rounded-lg border border-primary/25 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-2.5 transition-all hover:border-primary/50 hover:shadow-sm"
											>
												<div className="flex items-center justify-between">
													<div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
														<span className="icon-[solar--magic-stick-3-bold] size-3.5 text-primary" />
														{highlight.title}
													</div>
													{highlight.badge && (
														<span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
															{highlight.badge}
														</span>
													)}
												</div>
												{highlight.description && (
													<p className="text-[11px] leading-relaxed text-muted-foreground">
														{highlight.description}
													</p>
												)}
												<div className="mt-1 flex items-center justify-between text-[10px] text-primary/90 font-medium">
													<span>
														{highlight.modelKey && selectedModel === highlight.modelKey
															? (labels.recommendationSelected ?? "")
															: (labels.recommendationAction ?? "")}
													</span>
													<span className="icon-[solar--arrow-right-linear] size-3 transition-transform group-hover:translate-x-0.5" />
												</div>
											</div>
										</div>
									)}

									<div className="shrink-0 p-0.5">
										<div className="relative" onKeyDown={handleSearchKeyDown}>
											<span
												aria-hidden="true"
												className="icon-[solar--magnifer-linear] pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
											/>
											<input
												ref={searchInputRef}
												type="search"
												value={searchQuery}
												onChange={handleSearchChange}
												onClick={handleSearchClick}
												placeholder={labels.searchPlaceholder}
												aria-label={labels.searchPlaceholder}
												className="h-7 w-full rounded-md pl-7 pr-7 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
											/>
											{searchQuery && (
												<button
													type="button"
													onClick={handleClearSearch}
													aria-label={labels.clearSearch}
													className="absolute right-1 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
												>
													<span aria-hidden="true" className="icon-[solar--close-circle-linear] size-3" />
												</button>
											)}
										</div>
									</div>
									{menuLevels.length > 0 && (
										<>
											<DropdownMenuSub open={reasoningOpen} onOpenChange={setReasoningOpen}>
												<DropdownMenuSubTrigger className={COMPACT_ITEM_CLASS}>
													<span className="min-w-0 flex-1 truncate">{labels.reasoningHeader}</span>
													{currentLevel && (
														<span className="shrink-0 text-[11px] text-muted-foreground">
															{labels.levelLabel(currentLevel)}
														</span>
													)}
												</DropdownMenuSubTrigger>
												<AnimatePresence>
													{reasoningOpen && (
														<DropdownMenuSubContent
															forceMount
															asChild
															className="min-w-[130px] overflow-visible bg-background p-0"
															style={{ animation: "none" }}
														>
															<motion.div
																initial={{ opacity: 0, scale: 0.96, x: -6 }}
																animate={{ opacity: 1, scale: 1, x: 0 }}
																exit={{ opacity: 0, scale: 0.96, x: -6 }}
																transition={{ duration: 0.1, ease: [0.16, 1, 0.3, 1] }}
															>
																<div className="relative overflow-visible rounded-[inherit]">
																	<ThemeSurface slot="chat.modelSelectorReasoningMenu" />
																	<div className="relative z-10 overflow-hidden rounded-[inherit] p-1">
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
																				{level === currentLevel && (
																					<span className="icon-[solar--check-circle-linear] h-3 w-3 shrink-0" />
																				)}
																			</DropdownMenuItem>
																		))}
																	</div>
																</div>
															</motion.div>
														</DropdownMenuSubContent>
													)}
												</AnimatePresence>
											</DropdownMenuSub>
											<DropdownMenuSeparator />
										</>
									)}
									<div ref={modelListRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
										<DropdownMenuLabel className={COMPACT_LABEL_CLASS}>{labels.modelHeader}</DropdownMenuLabel>
										{filteredGroups.map((group) => (
										<div key={group.provider}>
											<div
												className={cn(
													"flex items-center gap-1 px-2 pb-0.5 pt-1 text-[10px] font-medium text-muted-foreground/50",
													classNames?.providerHeader,
												)}
											>
												<ProviderIcon symbol={group.icon} className="h-2.5 w-2.5" />
												<span className="min-w-0 truncate">{group.label}</span>
												{group.models[0]?.remote && (
													<span className="shrink-0 rounded-full bg-primary/15 px-1 text-[9px] font-medium text-primary">
														{labels.cloudOnly}
													</span>
												)}
											</div>
											{vendorSegments(group.models).map((segment) => (
												<div key={segment.key} className="pt-1 first:pt-0">
													{segment.vendor && (
														<div
															data-vendor-id={segment.vendorId}
															className="sticky top-0 z-10 flex items-center gap-1.5 bg-background px-2 py-1 text-[10px] font-semibold text-muted-foreground/80"
														>
															<VendorIcon
																name={segment.vendor}
																iconUrl={segment.vendorIcon}
																mono={segment.vendorMono}
																className="size-3.5"
															/>
															<span className="min-w-0 truncate">{segment.vendor}</span>
															<span className="shrink-0 font-normal text-muted-foreground/50">
																{segment.models.length}
															</span>
														</div>
													)}
													{segment.models.map((model) => (
														<DropdownMenuItem
															key={model.key}
															data-model-key={model.key}
															aria-current={model.key === selectedModel ? "true" : undefined}
															className={cn(
																COMPACT_ITEM_CLASS,
																model.key === selectedModel && "bg-accent text-accent-foreground",
																classNames?.item,
															)}
															onSelect={() => handleModelSelect(model.key)}
														>
															<span className="min-w-0 flex-1 truncate font-medium">{model.displayName}</span>
															{model.subtitle && (
																<span className="min-w-0 max-w-[40%] truncate font-mono text-[10px] text-muted-foreground/60">
																	{model.subtitle}
																</span>
															)}
															{model.isNew && labels.newBadge && (
																<span className="shrink-0 rounded-full bg-primary/10 px-1 text-[9px] font-semibold text-primary">
																	{labels.newBadge}
																</span>
															)}
															<ModelMultiplier label={labels.multiplierLabel?.(model)} />
															{model.supportsImage && (
																<span
																	aria-label={labels.visionBadge}
																	title={labels.visionBadge}
																	className="icon-[solar--gallery-linear] size-3 shrink-0 text-primary"
																/>
															)}
															{model.tags?.slice(0, 2).map((tag) => (
																<span
																	key={tag}
																	className="shrink-0 rounded-full bg-accent px-1 text-[9px] font-medium text-muted-foreground"
																>
																	{tag.trim()}
																</span>
															))}
															{model.key === defaultKey && (
																<span className="shrink-0 rounded-full bg-primary/15 px-1 text-[9px] font-medium text-primary">
																	{labels.defaultBadge}
																</span>
															)}
															{model.key === selectedModel && (
																<span className="icon-[solar--check-circle-linear] h-3 w-3 shrink-0" />
															)}
														</DropdownMenuItem>
													))}
												</div>
											))}
										</div>
										))}
										{filteredGroups.length === 0 && (
											<div className="flex min-h-24 flex-col items-center justify-center px-4 py-6 text-center">
												<span aria-hidden="true" className="icon-[solar--magnifer-linear] mb-1.5 size-4 text-muted-foreground" />
												<p className="text-xs font-medium text-foreground">{labels.noResults}</p>
												<p className="mt-0.5 text-[11px] text-muted-foreground">{labels.noResultsHint}</p>
											</div>
										)}
									</div>
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
	models: readonly ModelSelectorOptionView[];
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
			segments[segments.length - 1] = { ...last, models: [...last.models, model] };
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
