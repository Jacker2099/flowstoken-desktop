import { ProviderIcon } from "@vetta-org/theme-ui/shared";
import { useFlowstokenPicker } from "../../../domains/flowstoken/useFlowstokenPicker";
import { cn } from "@shared/lib/utils";
import { revalidateFlowstokenCatalog } from "@shared/store/atoms";
import { modelCatalog } from "@shared/store/model-catalog";
import { ThemeSurface } from "@vetta-org/theme-ui/appearance";
import {
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
import { AnimatePresence, motion } from "motion/react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MultiplierTag } from "./MultiplierTag";
import { resolveReasoning } from "./resolveReasoning";
import { type ModelOption, useModelOptions } from "./useModelOptions";

/** Optional reasoning-level submenu for a model picker. Controlled by the caller. */
export interface ModelSelectReasoning {
	/** Currently chosen level value, or undefined to fall back to the model default */
	value: string | undefined;
	/** Fired when the user picks a level */
	onChange: (level: string) => void;
}

export interface ModelSelectProps {
	/** Currently selected key ("provider/modelId"), or null when unset */
	value: string | null;
	/** Fired on selection; null only when allowClear and the user clears */
	onChange: (key: string | null) => void;
	/** Show an explicit "unset" entry so the selection can be cleared */
	allowClear?: boolean;
	disabled?: boolean;
	/** Trigger text when nothing is selected (defaults to common placeholder) */
	placeholder?: string;
	/** Extra classes for the trigger button (sizing/shape per call site) */
	triggerClassName?: string;
	/** When value is empty, auto-apply the configured default model once */
	autoSelectDefault?: boolean;
	/** Fires whenever the resolved selected option changes (load + change) */
	onSelectedOptionChange?: (option: ModelOption | null) => void;
	/** When set, adds a hover "推理" submenu to pick the selected model's reasoning level. */
	reasoning?: ModelSelectReasoning;
}

const MODEL_ITEM_SELECTOR = "[data-model-key]";

function normalizeSearchValue(value: string): string {
	return value.trim().toLocaleLowerCase();
}

/**
 * Shared rich model picker (grouped DropdownMenu with search + provider icons +
 * capability badges). Controlled via value/onChange for Claw, knowledge base,
 * scheduler, batch tasks, etc. Chat input uses ModelSelectorView (same panel look).
 */
export function ModelSelect({
	value,
	onChange,
	allowClear = false,
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
	const [open, setOpen] = useState(false);
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const modelListRef = useRef<HTMLDivElement>(null);

	const selectedOption = options.find((m) => m.key === value) ?? null;
	const resolved = useMemo(() => resolveReasoning(selectedOption), [selectedOption]);

	// "off" (disable thinking) is always offered on top of the model's configured levels.
	// When the model explicitly includes "none" in its levels, it replaces "off" so they
	// never appear together in the dropdown.
	const menuLevels = useMemo(() => {
		if (!resolved) return [];
		if (resolved.levels.includes("none")) {
			return ["none", ...resolved.levels.filter((l) => l !== "none" && l !== "off")];
		}
		return ["off", ...resolved.levels.filter((l) => l !== "off")];
	}, [resolved]);
	const isValidLevel = (v: string | undefined): v is string =>
		!!v && (v === "off" || v === "none" || (resolved?.levels.includes(v) ?? false));
	const currentLevel = resolved
		? isValidLevel(reasoning?.value)
			? reasoning?.value
			: resolved.default
		: undefined;
	const levelLabel = (v: string) => t(`modelSelect.reasoningLevel.${v}`, { defaultValue: v });

	const groupBadge = picker.groupBadge;

	const groups = useMemo(
		() =>
			[...grouped.entries()].map(([provider, models]) => ({
				provider,
				label: labelFor(provider),
				icon: iconFor(provider),
				models,
			})),
		[grouped, iconFor, labelFor],
	);

	const [activeTab, setActiveTab] = useState<string>(picker.initialTab);
	const [activeVendor, setActiveVendor] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setActiveTab(picker.enabled ? picker.initialTab : "all");
		setActiveVendor(null);
	}, [open, picker.enabled, picker.initialTab]);

	const activeTabProviders = useMemo(
		() => picker.tabs.find((tab) => tab.id === activeTab)?.providers ?? [],
		[picker.tabs, activeTab],
	);

	const vendorChips = picker.vendorBarByTab[activeTab] ?? [];

	const scrollListToTop = useCallback(() => {
		modelListRef.current?.scrollTo({ top: 0 });
		setActiveVendor(null);
	}, []);

	const scrollToVendor = useCallback((vendorId: string) => {
		const target = modelListRef.current?.querySelector<HTMLElement>(`[data-vendor-id="${vendorId}"]`);
		target?.scrollIntoView({ block: "start" });
		setActiveVendor(vendorId);
	}, []);

	const filteredGroups = useMemo(() => {
		let currentGroups = groups;
		if (picker.enabled && activeTab !== "all" && activeTabProviders.length > 0) {
			currentGroups = groups.filter((g) => activeTabProviders.includes(g.provider));
		}

		const query = normalizeSearchValue(searchQuery);
		if (!query) return currentGroups;

		return currentGroups.flatMap((group) => {
			const models = group.models.filter((model) =>
				[model.displayName, model.subtitle, model.modelId, model.provider, group.label, ...(model.tags ?? [])].some(
					(text) => text && normalizeSearchValue(text).includes(query),
				),
			);
			return models.length > 0 ? [{ ...group, models }] : [];
		});
	}, [groups, activeTab, activeTabProviders, picker.enabled, searchQuery]);

	// Auto-apply the configured default when nothing is selected yet (chat input).
	useEffect(() => {
		if (!autoSelectDefault) return;
		if (!value && defaultKey) onChange(defaultKey);
	}, [autoSelectDefault, value, defaultKey, onChange]);

	// Surface the resolved selected option to consumers (e.g. image support).
	useEffect(() => {
		if (options.length === 0) return;
		onSelectedOptionChange?.(selectedOption);
	}, [selectedOption, options.length, onSelectedOptionChange]);

	const handleOpenChange = useCallback((nextOpen: boolean) => {
		setOpen(nextOpen);
		// 打开时按 TTL 后台重新校验目录：服务端增删模型后，用户看到列表的那一刻就是最新的。
		if (nextOpen) {
			void modelCatalog.revalidate();
			void revalidateFlowstokenCatalog();
		}
		if (!nextOpen) {
			setReasoningOpen(false);
			setSearchQuery("");
		}
	}, []);

	useEffect(() => {
		if (!open) return;

		const frame = requestAnimationFrame(() => {
			searchInputRef.current?.focus();
			if (!value) return;
			const selectedItem = Array.from(
				modelListRef.current?.querySelectorAll<HTMLElement>(MODEL_ITEM_SELECTOR) ?? [],
			).find((item) => item.dataset.modelKey === value);
			selectedItem?.scrollIntoView({ block: "nearest" });
		});

		return () => cancelAnimationFrame(frame);
	}, [open, value]);

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
		onChange(key);
		setSearchQuery("");
	};

	if (options.length === 0 && !allowClear) return <></>;

	const showReasoning = !!reasoning && !!resolved && menuLevels.length > 0;

	return (
		<DropdownMenu open={open} onOpenChange={handleOpenChange}>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<button
					type="button"
					className={cn(
						"flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 text-[12px] text-foreground transition-colors hover:border-border/60 hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-primary/30 data-[state=open]:bg-primary/10 data-[state=open]:text-primary",
						triggerClassName,
					)}
				>
					{groupBadge ? (
						<span
							className={cn(
								"shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold tracking-tight",
								groupBadge.tone === "primary" && "bg-primary/20 text-primary",
								groupBadge.tone === "blue" && "bg-blue-500/15 text-blue-600 dark:text-blue-400",
								groupBadge.tone === "amber" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
							)}
						>
							{groupBadge.text}
						</span>
					) : selectedOption ? (
						<ProviderIcon symbol={iconFor(selectedOption.provider)} className="h-3.5 w-3.5" />
					) : null}
					<span className="min-w-0 flex-1 truncate text-left">
						{selectedOption?.displayName ?? placeholder ?? t("modelSelect.placeholder")}
					</span>
					{selectedOption && <MultiplierTag multiplier={selectedOption.multiplier} />}
					{showReasoning && currentLevel && (
						<span className="shrink-0 text-muted-foreground">{levelLabel(currentLevel)}</span>
					)}
					<span className="icon-[solar--alt-arrow-down-linear] h-3 w-3 shrink-0" />
				</button>
			</DropdownMenuTrigger>
			<AnimatePresence>
				{open && (
					<DropdownMenuContent
						forceMount
						asChild
						align="start"
						className="w-[min(24rem,calc(100vw-2rem))] min-w-[260px] max-w-[24rem] overflow-visible p-0"
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
								<div className="relative z-10 flex max-h-[min(420px,65vh)] flex-col overflow-hidden rounded-[inherit] p-1">
									{/* FlowsToken 分组切换 Tabs（目录下发） */}
									{picker.enabled && picker.tabs.length > 0 && (
										<div className="shrink-0 p-1 border-b border-border/40">
											<div
												className={cn(
													"grid gap-1 rounded-lg bg-muted/60 p-0.5 text-[11px]",
													picker.tabs.length === 4 ? "grid-cols-4" : "grid-cols-3",
												)}
											>
												{picker.tabs.map((tab) => (
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
												{t("modelSelect.allVendors")}
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

									<div className="shrink-0 p-1">
										<div className="relative" onKeyDown={handleSearchKeyDown}>
											<span
												aria-hidden="true"
												className="icon-[solar--magnifer-linear] pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
											/>
											<input
												ref={searchInputRef}
												type="search"
												value={searchQuery}
												onChange={handleSearchChange}
												onClick={handleSearchClick}
												placeholder={t("modelSelect.searchPlaceholder")}
												aria-label={t("modelSelect.searchPlaceholder")}
												className="h-8 w-full rounded-md border border-border/60 bg-background/70 pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50"
											/>
											{searchQuery && (
												<button
													type="button"
													onClick={handleClearSearch}
													aria-label={t("modelSelect.clearSearch")}
													className="absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
												>
													<span aria-hidden="true" className="icon-[solar--close-circle-linear] size-3.5" />
												</button>
											)}
										</div>
									</div>
									{showReasoning && (
										<>
											<DropdownMenuSub open={reasoningOpen} onOpenChange={setReasoningOpen}>
												<DropdownMenuSubTrigger>
													<span className="min-w-0 flex-1 truncate">{t("modelSelect.reasoningHeader")}</span>
													{currentLevel && (
														<span className="shrink-0 text-muted-foreground">{levelLabel(currentLevel)}</span>
													)}
												</DropdownMenuSubTrigger>
												<AnimatePresence>
													{reasoningOpen && (
														<DropdownMenuSubContent
															forceMount
															asChild
															className="min-w-[160px] overflow-visible p-0"
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
																		<DropdownMenuLabel>{t("modelSelect.reasoningHeader")}</DropdownMenuLabel>
																		{menuLevels.map((level) => (
																			<DropdownMenuItem key={level} onSelect={() => reasoning?.onChange(level)}>
																				<span className="min-w-0 flex-1 truncate">{levelLabel(level)}</span>
																				{level === currentLevel && (
																					<span className="icon-[solar--check-circle-linear] h-3.5 w-3.5 shrink-0" />
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
										{allowClear && (
											<DropdownMenuItem onSelect={() => onChange(null)}>
												<span className="min-w-0 flex-1 truncate text-muted-foreground">
													{t("modelSelect.unset")}
												</span>
												{value == null && (
													<span className="icon-[solar--check-circle-linear] h-3.5 w-3.5 shrink-0" />
												)}
											</DropdownMenuItem>
										)}
										<DropdownMenuLabel>{t("modelSelect.modelHeader")}</DropdownMenuLabel>
										{filteredGroups.map((group) => (
											<div key={group.provider}>
												<div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-muted-foreground/50">
													<ProviderIcon symbol={group.icon} className="h-3 w-3" />
													{group.label}
													{group.models[0]?.remote && (
														<span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
															{t("modelSelect.cloudOnly")}
														</span>
													)}
												</div>
												{vendorSegments(group.models).map((segment) => (
													<div key={segment.key} className="pt-1 first:pt-0">
														{segment.vendor && (
															<div
																data-vendor-id={segment.vendorId}
																className="sticky top-0 z-10 flex items-center gap-1.5 bg-popover px-3 py-1 text-[10px] font-semibold text-muted-foreground/80"
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
														{segment.models.map((m) => (
													<DropdownMenuItem
														key={m.key}
														data-model-key={m.key}
														aria-current={m.key === value ? "true" : undefined}
														className={cn("rounded-md", m.key === value && "bg-accent text-accent-foreground")}
														onSelect={() => handleModelSelect(m.key)}
													>
														<span className="min-w-0 flex-1 truncate font-medium">{m.displayName}</span>
														{m.subtitle && (
															<span className="min-w-0 max-w-[40%] truncate font-mono text-[10px] text-muted-foreground/60">
																{m.subtitle}
															</span>
														)}
														{m.isNew && (
															<span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
																{t("modelSelect.newBadge")}
															</span>
														)}
														<MultiplierTag multiplier={m.multiplier} />
														{m.supportsImage && (
															<span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
																{t("modelSelect.visionBadge")}
															</span>
														)}
														{m.tags?.slice(0, 2).map((tag) => (
															<span
																key={tag}
																className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
															>
																{tag.trim()}
															</span>
														))}
														{m.key === defaultKey && (
															<span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
																{t("modelSelect.defaultBadge")}
															</span>
														)}
														{m.key === value && (
															<span className="icon-[solar--check-circle-linear] h-3.5 w-3.5 shrink-0" />
														)}
													</DropdownMenuItem>
														))}
													</div>
												))}
											</div>
										))}
										{filteredGroups.length === 0 && (
											<div className="flex min-h-32 flex-col items-center justify-center px-6 py-8 text-center">
												<span
													aria-hidden="true"
													className="icon-[solar--magnifer-linear] mb-2 size-5 text-muted-foreground"
												/>
												<p className="text-sm font-medium text-foreground">{t("modelSelect.noResults")}</p>
												<p className="mt-1 text-xs text-muted-foreground">{t("modelSelect.noResultsHint")}</p>
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

interface VendorSegment {
	key: string;
	vendor?: string;
	vendorId?: string;
	vendorIcon?: string;
	vendorMono?: boolean;
	models: ModelOption[];
}

/** Split a provider's already-sorted models into vendor segments (for sticky section headers). */
function vendorSegments(models: readonly ModelOption[]): VendorSegment[] {
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
