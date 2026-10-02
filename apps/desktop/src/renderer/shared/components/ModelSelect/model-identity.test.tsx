// @vitest-environment jsdom
import type { FlowstokenCatalog, ModelsConfigData } from "@preload/api";
import { i18n, initI18n } from "@shared/i18n";
import { flowstokenCatalogAtom, localModelsConfigAtom } from "@shared/store/model-catalog-atoms";
import { render, renderHook, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ModelSelect } from "./ModelSelect";
import { modelOptionFromIndex } from "./model-option-identity";
import { useModelOptions } from "./useModelOptions";

function setup(reverse = false) {
	const providers = {
		"flowstoken-default": {
			models: [{ id: "model", name: "Current name", reasoning: true, reasoningLevels: ["low", "high"] }],
		},
		"flowstoken-normal": { models: [{ id: "model", name: "Old name" }] },
		personal: { models: [{ id: "model", name: "Personal model" }] },
	};
	const config: ModelsConfigData = {
		defaultModel: "flowstoken-normal/model",
		providers: reverse ? Object.fromEntries(Object.entries(providers).reverse()) : providers,
	};
	const catalog: FlowstokenCatalog = {
		schema: 2,
		revision: "identity",
		generated: 1,
		pricingVersion: "1",
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [
			{
				id: "default",
				providerId: "flowstoken-default",
				title: "Daily",
				subtitle: "",
				vendors: [
					{
						id: "openai",
						name: "OpenAI",
						icon: "openai.svg",
						mono: true,
						models: [
							{ id: "model", name: "Current name", released: null, tags: [], vision: false, image: false },
						],
					},
				],
			},
		],
	};
	const store = createStore();
	store.set(localModelsConfigAtom, config);
	store.set(flowstokenCatalogAtom, catalog);
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: { models: { get: async () => config, fetchRemote: async () => ({ providers: {} }) } },
	});
	return {
		config,
		store,
		wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>,
	};
}

beforeEach(async () => {
	initI18n();
	await i18n.changeLanguage("en");
});

it.each([false, true])(
	"shows one canonical model for the legacy alias regardless of provider order (%s)",
	(reverse) => {
		const { wrapper, store } = setup(reverse);
		const { result } = renderHook(() => useModelOptions(), { wrapper });
		expect(result.current.options.map((option) => option.key).sort()).toEqual([
			"flowstoken-default/model",
			"personal/model",
		]);
		const selected = modelOptionFromIndex(
			new Map(result.current.options.map((option) => [option.key, option])),
			"flowstoken-normal/model",
		);
		expect(selected).toMatchObject({ key: "flowstoken-default/model", reasoningLevels: ["low", "high"] });
		expect(store.get(localModelsConfigAtom)?.defaultModel).toBe("flowstoken-normal/model");
	},
);

it("renders a saved legacy selection with current name and reasoning without changing its saved key", () => {
	const { wrapper } = setup();
	const change = vi.fn();
	render(
		<ModelSelect
			value="flowstoken-normal/model"
			onChange={change}
			reasoning={{ value: "high", onChange: vi.fn() }}
		/>,
		{ wrapper },
	);
	expect(screen.getByText("Current name")).toBeTruthy();
	expect(change).not.toHaveBeenCalled();
});

it("keeps an alias-only provider selectable rather than inventing an unavailable canonical key", () => {
	const { wrapper, store, config } = setup();
	delete config.providers["flowstoken-default"];
	store.set(localModelsConfigAtom, config);
	const { result } = renderHook(() => useModelOptions(), { wrapper });
	expect(result.current.options.find((option) => option.provider === "flowstoken-normal")?.key).toBe(
		"flowstoken-normal/model",
	);
});
