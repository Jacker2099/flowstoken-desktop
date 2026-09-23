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
	/** 参与搜索匹配的附加标签。 */
	readonly tags?: readonly string[];
	/** 来自远程目录（云端）；分组头会打上 `labels.cloudOnly` 徽章。 */
	readonly remote?: boolean;
	readonly supportsImage?: boolean;
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

export interface ModelSelectorViewProps {
	selectedModel?: string;
	selectedOption: ModelSelectorOptionView | null;
	currentLevel?: string;
	menuLevels: string[];
	groups: readonly ModelSelectorProviderGroup[];
	defaultKey?: string;
	labels: ModelSelectorLabels;
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
	className,
	classNames,
	onModelSelect,
	onReasoningSelect,
	onOpenChange,
}: ModelSelectorViewProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const modelListRef = useRef<HTMLDivElement>(null);

	const hasFlowstokenGroups = useMemo(() => {
		return groups.some((g) => g.provider.startsWith("flowstoken-"));
	}, [groups]);

	const [activeTab, setActiveTab] = useState<string>("all");
	const [vendorFilter, setVendorFilter] = useState<string>("all");

	useEffect(() => {
		if (!open) return;
		if (selectedOption?.provider?.startsWith("flowstoken-")) {
			if (selectedOption.provider === "flowstoken-smart") {
				setActiveTab("flowstoken-smart");
			} else if (selectedOption.provider === "flowstoken-default" || selectedOption.provider === "flowstoken-normal") {
				setActiveTab("flowstoken-default");
			} else if (selectedOption.provider === "flowstoken-official") {
				setActiveTab("flowstoken-official");
			}
		} else if (hasFlowstokenGroups) {
			setActiveTab("flowstoken-smart");
		} else {
			setActiveTab("all");
		}
		setVendorFilter("all");
	}, [open, selectedOption, hasFlowstokenGroups]);

	const filteredGroups = useMemo(() => {
		let currentGroups = groups;
		if (activeTab === "flowstoken-smart") {
			currentGroups = groups.filter((g) => g.provider === "flowstoken-smart");
		} else if (activeTab === "flowstoken-default") {
			currentGroups = groups.filter((g) => g.provider === "flowstoken-default" || g.provider === "flowstoken-normal");
		} else if (activeTab === "flowstoken-official") {
			currentGroups = groups.filter((g) => g.provider === "flowstoken-official");
		}

		if (activeTab === "flowstoken-official" && vendorFilter !== "all") {
			currentGroups = currentGroups
				.map((g) => {
					const models = g.models.filter((m) => {
						const id = m.modelId.toLowerCase();
						if (vendorFilter === "anthropic") return id.includes("claude") || id.startsWith("anthropic/");
						if (vendorFilter === "openai") return id.includes("gpt") || id.startsWith("openai/") || id.includes("o1") || id.includes("o3") || id.includes("o4");
						if (vendorFilter === "deepseek") return id.includes("deepseek");
						if (vendorFilter === "google") return id.includes("gemini") || id.startsWith("google/") || id.includes("gemma");
						if (vendorFilter === "domestic") return id.includes("kimi") || id.includes("minimax") || id.includes("glm") || id.includes("qwen") || id.includes("grok") || id.includes("moonshot") || id.includes("zai") || id.includes("alibaba") || id.includes("step");
						return true;
					});
					return { ...g, models };
				})
				.filter((g) => g.models.length > 0);
		}

		const query = normalizeSearchValue(searchQuery);
		if (!query) return currentGroups;

		return currentGroups.flatMap((group) => {
			const models = group.models.filter((model) =>
				[
					model.displayName,
					model.modelId,
					model.provider,
					group.label,
					...(model.tags ?? []),
				].some((value) => normalizeSearchValue(value).includes(query)),
			);
			return models.length > 0 ? [{ ...group, models }] : [];
		});
	}, [groups, activeTab, vendorFilter, searchQuery]);

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

	const groupBadge = useMemo(() => {
		if (!selectedOption?.provider) return null;
		if (selectedOption.provider === "flowstoken-smart") return "智能";
		if (selectedOption.provider === "flowstoken-default" || selectedOption.provider === "flowstoken-normal") return "普通";
		if (selectedOption.provider === "flowstoken-official") return "官方";
		return null;
	}, [selectedOption]);

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
					{groupBadge ? (
						<span
							className={cn(
								"shrink-0 rounded px-1 text-[9px] font-semibold leading-[14px]",
								groupBadge === "智能" && "bg-primary/20 text-primary font-bold",
								groupBadge === "普通" && "bg-blue-500/15 text-blue-600 dark:text-blue-400",
								groupBadge === "官方" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
							)}
						>
							{groupBadge}
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
							"w-[min(22rem,calc(100vw-2rem))] min-w-[260px] max-w-[22rem] overflow-visible bg-background p-0 shadow-lg",
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
									{/* FlowsToken 三组切换 Tabs */}
									{hasFlowstokenGroups && (
										<div className="shrink-0 p-1 border-b border-border/40">
											<div className="grid grid-cols-4 gap-1 rounded-lg bg-muted/60 p-0.5 text-[11px]">
												<button
													type="button"
													onClick={() => {
														setActiveTab("flowstoken-smart");
														setVendorFilter("all");
													}}
													className={cn(
														"flex items-center justify-center gap-1 rounded-md px-1.5 py-1 font-medium transition-all",
														activeTab === "flowstoken-smart"
															? "bg-background text-primary shadow-sm font-semibold"
															: "text-muted-foreground hover:text-foreground",
													)}
												>
													<span className="icon-[solar--magic-stick-3-linear] size-3 shrink-0" />
													智能组
												</button>
												<button
													type="button"
													onClick={() => {
														setActiveTab("flowstoken-default");
														setVendorFilter("all");
													}}
													className={cn(
														"flex items-center justify-center gap-1 rounded-md px-1.5 py-1 font-medium transition-all",
														activeTab === "flowstoken-default"
															? "bg-background text-primary shadow-sm font-semibold"
															: "text-muted-foreground hover:text-foreground",
													)}
												>
													<span className="icon-[solar--bolt-linear] size-3 shrink-0" />
													普通组
												</button>
												<button
													type="button"
													onClick={() => {
														setActiveTab("flowstoken-official");
														setVendorFilter("all");
													}}
													className={cn(
														"flex items-center justify-center gap-1 rounded-md px-1.5 py-1 font-medium transition-all",
														activeTab === "flowstoken-official"
															? "bg-background text-primary shadow-sm font-semibold"
															: "text-muted-foreground hover:text-foreground",
													)}
												>
													<span className="icon-[solar--crown-linear] size-3 shrink-0" />
													官方组
												</button>
												<button
													type="button"
													onClick={() => {
														setActiveTab("all");
														setVendorFilter("all");
													}}
													className={cn(
														"flex items-center justify-center gap-1 rounded-md px-1.5 py-1 font-medium transition-all",
														activeTab === "all"
															? "bg-background text-primary shadow-sm font-semibold"
															: "text-muted-foreground hover:text-foreground",
													)}
												>
													全部
												</button>
											</div>
										</div>
									)}

									{/* 官方组厂商快捷筛选 Chips */}
									{activeTab === "flowstoken-official" && (
										<div className="shrink-0 flex items-center gap-1 overflow-x-auto px-1.5 pt-1.5 pb-0.5 text-[10px] no-scrollbar">
											{[
												{ id: "all", label: "全部厂商" },
												{ id: "anthropic", label: "Claude" },
												{ id: "openai", label: "OpenAI" },
												{ id: "deepseek", label: "DeepSeek" },
												{ id: "google", label: "Google" },
												{ id: "domestic", label: "国内原厂" },
											].map((chip) => (
												<button
													key={chip.id}
													type="button"
													onClick={() => setVendorFilter(chip.id)}
													className={cn(
														"shrink-0 rounded-full px-2 py-0.5 text-[10px] transition-colors",
														vendorFilter === chip.id
															? "bg-primary/20 font-semibold text-primary"
															: "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
													)}
												>
													{chip.label}
												</button>
											))}
										</div>
									)}

									{/* 智能组专属推荐卡片 */}
									{activeTab === "flowstoken-smart" && !searchQuery && (
										<div className="shrink-0 p-1.5">
											<div
												onClick={() => {
													const smartOption = groups.find((g) => g.provider === "flowstoken-smart")?.models[0];
													if (smartOption) handleModelSelect(smartOption.key);
												}}
												className="group flex cursor-pointer flex-col gap-1 rounded-lg border border-primary/25 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-2.5 transition-all hover:border-primary/50 hover:shadow-sm"
											>
												<div className="flex items-center justify-between">
													<div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
														<span className="icon-[solar--magic-stick-3-bold] size-3.5 text-primary" />
														Bestoo-Auto (智能选模)
													</div>
													<span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
														推荐 · 智能组专享
													</span>
												</div>
												<p className="text-[11px] leading-relaxed text-muted-foreground">
													智能组唯一核心模型。自动根据任务难易度调度 Claude Sonnet 4.6、GPT-5.6 Sol、DeepSeek 等顶尖模型，兼顾超高智商与性价比。
												</p>
												<div className="mt-1 flex items-center justify-between text-[10px] text-primary/90 font-medium">
													<span>
														{selectedModel === "flowstoken-smart/Bestoo-Auto"
															? "✓ 当前已选用此模型"
															: "点击直接选用此模型"}
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
											{group.models.map((model) => (
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
													<span className="min-w-0 flex-1 truncate">{model.displayName}</span>
													<ModelMultiplier label={labels.multiplierLabel?.(model)} />
													{model.supportsImage && (
														<span
															aria-label={labels.visionBadge}
															title={labels.visionBadge}
															className="icon-[solar--gallery-linear] size-3 shrink-0 text-primary"
														/>
													)}
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
