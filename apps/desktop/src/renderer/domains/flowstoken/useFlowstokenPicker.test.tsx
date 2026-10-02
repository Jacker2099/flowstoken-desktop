// @vitest-environment jsdom
import type { ModelOption } from "@shared/components/ModelSelect/useModelOptions";
import { flowstokenCatalogAtom } from "@shared/store/atoms";
import { renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { FLOWSTOKEN_ALL_TAB_ID, useFlowstokenPicker } from "./useFlowstokenPicker";

vi.mock("@shared/i18n", () => ({
	i18n: { t: (key: string) => `i18n:${key}` },
}));

const model = (id: string, name?: string) => ({
	id,
	name: name ?? id,
	released: null,
	tags: [],
	vision: false,
	image: false,
});

const catalog = {
	schema: 1 as const,
	generated: 1,
	pricingVersion: "pv",
	newWindowDays: 30,
	iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
	groups: [
		{
			id: "smart" as const,
			providerId: "flowstoken-smart",
			title: "智能组",
			subtitle: "",
			defaultModel: "Bestoo-Auto",
			highlight: { title: "Bestoo-Auto（智能选模）", badge: "推荐", description: "自动调度" },
			vendors: [{ id: "bestoo", name: "Bestoo AI", icon: null, mono: false, models: [model("Bestoo-Auto")] }],
		},
		{
			id: "default" as const,
			providerId: "flowstoken-default",
			title: "普通组",
			subtitle: "",
			vendors: [
				{
					id: "anthropic",
					name: "Anthropic",
					icon: "claude-color.svg",
					mono: false,
					models: [model("claude-opus-5-5")],
				},
				{
					id: "openai",
					name: "OpenAI",
					icon: "openai.svg",
					mono: true,
					models: [model("gpt-6-sol"), model("gpt-5.5")],
				},
			],
		},
		{
			id: "vip" as const,
			providerId: "flowstoken-official",
			title: "官方组",
			subtitle: "",
			vendors: [
				{
					id: "anthropic",
					name: "Anthropic",
					icon: "claude-color.svg",
					mono: false,
					models: [model("anthropic/claude-opus-5.5")],
				},
			],
		},
	],
};

const option = (provider: string, modelId: string, vendorId?: string): ModelOption => ({
	provider,
	modelId,
	displayName: modelId,
	key: `${provider}/${modelId}`,
	vendorId,
});

const options: ModelOption[] = [
	option("flowstoken-smart", "Bestoo-Auto", "bestoo"),
	option("flowstoken-default", "claude-opus-5-5", "anthropic"),
	option("flowstoken-default", "gpt-6-sol", "openai"),
	option("flowstoken-default", "gpt-5.5", "openai"),
	option("flowstoken-official", "anthropic/claude-opus-5.5", "anthropic"),
];
const grouped = new Map<string, ModelOption[]>([
	["flowstoken-smart", [options[0]]],
	["flowstoken-default", [options[1], options[2], options[3]]],
	["flowstoken-official", [options[4]]],
]);

function setup(selectedModel: string | null, cat: unknown = catalog, available = options, providers = grouped) {
	const store = createStore();
	store.set(flowstokenCatalogAtom, cat as never);
	const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
	return renderHook(() => useFlowstokenPicker(available, providers, selectedModel), { wrapper });
}

it("opens the first available billing group when no smart provider is configured", () => {
	const defaults = options.filter((o) => o.provider === "flowstoken-default");
	const { result } = setup(null, catalog, defaults, new Map([["flowstoken-default", defaults]]));
	expect(result.current.initialTab).toBe("default");
});

it("recognizes the normal provider from earlier clients as the default billing group", () => {
	const legacy = option("flowstoken-normal", "gpt-6-sol", "openai");
	const { result } = setup(legacy.key, catalog, [legacy], new Map([[legacy.provider, [legacy]]]));
	expect(result.current.enabled).toBe(true);
	expect(result.current.initialTab).toBe("default");
	expect(result.current.tabs[0].providers).toContain("flowstoken-normal");
	expect(result.current.groupBadge?.text).toBe("普通组");
});

it("recommends only an available chat model when the catalog's preferred model was removed", () => {
	const changed = {
		...catalog,
		groups: catalog.groups.map((group) =>
			group.id === "smart" ? { ...group, defaultModel: "removed-model" } : group,
		),
	};
	expect(setup(null, changed).result.current.highlight?.modelKey).toBe("flowstoken-smart/Bestoo-Auto");
});

it("builds tabs in catalog order plus an all tab", () => {
	const { result } = setup(null);
	expect(result.current.enabled).toBe(true);
	expect(result.current.tabs.map((t) => t.id)).toEqual(["smart", "default", "vip", FLOWSTOKEN_ALL_TAB_ID]);
	expect(result.current.tabs.map((t) => t.label)).toEqual([
		"智能组",
		"普通组",
		"官方组",
		"i18n:common:modelSelect.groupAll",
	]);
	expect(result.current.tabs[1].providers).toEqual(["flowstoken-default"]);
});

it("defaults the tab to the selected model's group, else smart", () => {
	expect(setup("flowstoken-official/anthropic/claude-opus-5.5").result.current.initialTab).toBe("vip");
	expect(setup("flowstoken-default/gpt-6-sol").result.current.initialTab).toBe("default");
	expect(setup(null).result.current.initialTab).toBe("smart");
	expect(setup("other-provider/x").result.current.initialTab).toBe(FLOWSTOKEN_ALL_TAB_ID);
});

it("emits the vendor bar in server order with counts and icon URLs", () => {
	const { result } = setup(null);
	const chips = result.current.vendorBarByTab.default;
	expect(chips.map((c) => c.id)).toEqual(["anthropic", "openai"]);
	expect(chips[0].iconUrl).toBe("https://www.flowstoken.com/brand/vendor-icons/claude-color.svg");
	expect(chips[0].count).toBe(1);
	expect(chips[1]).toMatchObject({ name: "OpenAI", mono: true, count: 2 });
	expect(result.current.vendorBarByTab.vip.map((c) => c.id)).toEqual(["anthropic"]);
});

it("feeds the smart highlight card from the catalog and i18n-falls back", () => {
	const { result } = setup(null);
	expect(result.current.highlight).toMatchObject({
		tabId: "smart",
		title: "Bestoo-Auto（智能选模）",
		badge: "推荐",
		modelKey: "flowstoken-smart/Bestoo-Auto",
	});

	const noHighlight = {
		...catalog,
		groups: catalog.groups.map((g) => (g.id === "smart" ? { ...g, highlight: undefined } : g)),
	};
	const fallback = setup(null, noHighlight).result.current.highlight;
	expect(fallback?.title).toBe("i18n:common:modelSelect.smartHighlightTitle");
	expect(fallback?.description).toBe("i18n:common:modelSelect.smartHighlightDescription");
});

it("derives the trigger group badge from the selected model", () => {
	expect(setup("flowstoken-smart/Bestoo-Auto").result.current.groupBadge).toEqual({
		text: "智能组",
		tone: "primary",
	});
	expect(setup("flowstoken-default/gpt-6-sol").result.current.groupBadge).toEqual({
		text: "普通组",
		tone: "blue",
	});
	expect(setup("flowstoken-official/anthropic/claude-opus-5.5").result.current.groupBadge).toEqual({
		text: "官方组",
		tone: "amber",
	});
	expect(setup("other/x").result.current.groupBadge).toBeNull();
});

it("disables when no FlowsToken providers exist", () => {
	const store = createStore();
	store.set(flowstokenCatalogAtom, catalog as never);
	const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
	const empty = new Map<string, ModelOption[]>([["other", [option("other", "x")]]]);
	const { result } = renderHook(() => useFlowstokenPicker([option("other", "x")], empty, null), { wrapper });
	expect(result.current.enabled).toBe(false);
	expect(result.current.tabs).toEqual([]);
});

it("accepts a newly configured billing group named all without colliding with the combined tab", () => {
	const added = {
		...catalog,
		schema: 2 as const,
		revision: "new-group",
		groups: [
			{
				...catalog.groups[1],
				id: "all",
				providerId: "flowstoken-group-all",
				title: "研究组",
				defaultModel: "gpt-6-sol",
			},
			...catalog.groups,
		],
	};
	const extra = option("flowstoken-group-all", "gpt-6-sol", "openai");
	const result = setup(extra.key, added, [...options, extra], new Map([...grouped, [extra.provider, [extra]]])).result;
	expect(result.current.tabs[0]).toMatchObject({
		id: "all",
		label: "研究组",
		providers: [extra.provider],
		modelCount: 1,
	});
	expect(result.current.tabs.at(-1)?.id).toBe(FLOWSTOKEN_ALL_TAB_ID);
	expect(result.current.initialTab).toBe("all");
	expect(result.current.highlightByTab.all.modelKey).toBe(extra.key);
});

it("preserves a retired selection as unavailable instead of recommending another billing group", () => {
	const retired = { ...catalog, schema: 2 as const, revision: "retired", groups: [] };
	const result = setup("flowstoken-official/anthropic/claude-opus-5.5", retired, [], new Map()).result;
	expect(result.current.selectedUnavailable).toBe(true);
	expect(result.current.highlightByTab).toEqual({});
	expect(result.current.enabled).toBe(false);
});
