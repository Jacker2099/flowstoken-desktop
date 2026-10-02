// @vitest-environment jsdom
import type { FlowstokenCatalog, ModelsConfigData } from "@preload/api";
import { act, renderHook, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useModelOptions } from "../components/ModelSelect/useModelOptions";
import { useModelCatalogSync } from "../hooks/useModelCatalogSync";
import { catalogModelEntry, revalidateFlowstokenCatalog } from "./flowstoken-catalog";
import { modelCatalog } from "./model-catalog";
import { flowstokenCatalogAtom, localModelsConfigAtom, remoteProvidersAtom } from "./model-catalog-atoms";

function catalog(ids: string[], version: string): FlowstokenCatalog {
	return {
		schema: 1, generated: 1, pricingVersion: version, newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [{ id: "default", providerId: "flowstoken-default", title: "普通组", subtitle: "",
			vendors: [{ id: "openai", name: "OpenAI", icon: "openai.svg", mono: true,
				models: ids.map((id) => ({ id, name: `Name ${id}`, released: null, tags: [],
					vision: !id.includes("image"), image: id.includes("image") })),
			}],
		}],
	};
}

let live: FlowstokenCatalog;
let config: ModelsConfigData;
let testDay = 0;
const get = vi.fn(async () => structuredClone(config));
const getCatalog = vi.fn(async () => {
	// IPC returns only after main-process reconciliation; exercise the actual renderer state path.
	config = {
		providers: { "flowstoken-default": {
			api: "openai-completions", apiKey: "***",
			models: live.groups[0].vendors.flatMap((v) => v.models).map((m) => ({
				id: m.id, name: m.name, input: m.vision ? ["text", "image"] : ["text"],
			})),
		} },
	};
	return structuredClone(live);
});

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date(2030, 0, ++testDay));
	get.mockClear();
	getCatalog.mockClear();
	live = catalog(["old", "gpt-image-2"], "first");
	config = { providers: { "flowstoken-default": { api: "openai-completions", models: [{ id: "stale" }] } } };
	Object.defineProperty(window, "vetta", { configurable: true, value: {
		models: { get, fetchRemote: async () => ({ providers: {} }) },
		flowstoken: { getCatalog },
	} });
	const store = getDefaultStore();
	store.set(flowstokenCatalogAtom, null);
	store.set(localModelsConfigAtom, null);
	store.set(remoteProvidersAtom, {});
	modelCatalog.reset();
});

afterEach(() => vi.useRealTimers());

it("keeps catalog names and capabilities for the default provider from earlier clients", () => {
	expect(catalogModelEntry(catalog(["gpt-6-sol"], "legacy"), "flowstoken-normal", "gpt-6-sol")).toMatchObject({
		name: "Name gpt-6-sol", vendorId: "openai", vision: true,
	});
});

it("loads catalog order, vendor metadata and vision while excluding image-generation models from chat", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	expect(result.current.options[0]).toMatchObject({
		displayName: "Name old", supportsImage: true, vendorId: "openai",
		vendorIcon: "https://www.flowstoken.com/brand/vendor-icons/openai.svg", vendorMono: true,
	});
	expect(getDefaultStore().get(localModelsConfigAtom)?.providers["flowstoken-default"].models).toHaveLength(2);
});

it("refreshes a continuously mounted picker after six hours, removing old models and preserving server order", async () => {
	const { result } = renderHook(() => { useModelCatalogSync(); return useModelOptions(); });
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	live = catalog(["new-z", "new-a"], "second");
	await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); });
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["new-z", "new-a"]));
	expect(getDefaultStore().get(flowstokenCatalogAtom)?.pricingVersion).toBe("second");
	expect(getCatalog).toHaveBeenCalledTimes(2);
	await act(async () => { window.dispatchEvent(new Event("focus")); });
	expect(getCatalog).toHaveBeenCalledTimes(2);
});

it("keeps both existing sources when a later catalog refresh fails", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	getCatalog.mockRejectedValueOnce(new Error("offline"));
	vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
	await act(async () => { await revalidateFlowstokenCatalog(); });
	expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]);
	expect(getDefaultStore().get(flowstokenCatalogAtom)?.pricingVersion).toBe("first");
});

it("respects an explicit text-only override instead of forcing the catalog vision badge", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	await act(async () => { getDefaultStore().set(localModelsConfigAtom, {
		providers: { "flowstoken-default": { models: [{ id: "old", input: ["text"] }] } },
	}); });
	expect(result.current.options[0].supportsImage).toBe(false);
});
