// @vitest-environment jsdom
import type { FlowstokenCatalog, ModelsConfigData } from "@preload/api";
import { act, renderHook, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useModelOptions } from "../components/ModelSelect/useModelOptions";
import { useModelCatalogSync } from "../hooks/useModelCatalogSync";
import { catalogModelEntry, invalidateFlowstokenCatalog, revalidateFlowstokenCatalog } from "./flowstoken-catalog";
import { modelCatalog } from "./model-catalog";
import { flowstokenCatalogAtom, localModelsConfigAtom, remoteProvidersAtom } from "./model-catalog-atoms";

function catalog(ids: string[], version: string): FlowstokenCatalog {
	return {
		schema: 1,
		generated: 1,
		pricingVersion: version,
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [
			{
				id: "default",
				providerId: "flowstoken-default",
				title: "普通组",
				subtitle: "",
				vendors: [
					{
						id: "openai",
						name: "OpenAI",
						icon: "openai.svg",
						mono: true,
						models: ids.map((id) => ({
							id,
							name: `Name ${id}`,
							released: null,
							tags: [],
							vision: !id.includes("image"),
							image: id.includes("image"),
						})),
					},
				],
			},
		],
	};
}

let live: FlowstokenCatalog;
let config: ModelsConfigData;
let testDay = 0;
const get = vi.fn(async () => structuredClone(config));
const getCatalog = vi.fn(async () => {
	// IPC returns only after main-process reconciliation; exercise the actual renderer state path.
	config = {
		providers: Object.fromEntries(
			live.groups.map((group) => [
				group.providerId,
				{
					api: "openai-completions",
					apiKey: "***",
					models: group.vendors
						.flatMap((v) => v.models)
						.map((m) => ({
							id: m.id,
							name: m.name,
							input: m.vision ? ["text", "image"] : ["text"],
						})),
				},
			]),
		),
	};
	return structuredClone(live);
});
const getCatalogSnapshot = vi.fn(async () => ({ catalog: await getCatalog(), config: structuredClone(config) }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(new Date(2030, 0, ++testDay));
	get.mockClear();
	getCatalog.mockClear();
	getCatalogSnapshot.mockClear();
	invalidateFlowstokenCatalog();
	live = catalog(["old", "gpt-image-2"], "first");
	config = { providers: { "flowstoken-default": { api: "openai-completions", models: [{ id: "stale" }] } } };
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: {
			models: { get, fetchRemote: async () => ({ providers: {} }) },
			flowstoken: { getCatalog, getCatalogSnapshot },
		},
	});
	const store = getDefaultStore();
	store.set(flowstokenCatalogAtom, null);
	store.set(localModelsConfigAtom, null);
	store.set(remoteProvidersAtom, {});
	modelCatalog.reset();
});

afterEach(() => vi.useRealTimers());

it("keeps catalog names and capabilities for the default provider from earlier clients", () => {
	expect(catalogModelEntry(catalog(["gpt-6-sol"], "legacy"), "flowstoken-normal", "gpt-6-sol")).toMatchObject({
		name: "Name gpt-6-sol",
		vendorId: "openai",
		vision: true,
	});
});

it("loads catalog order, vendor metadata and vision while excluding image-generation models from chat", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	expect(result.current.options[0]).toMatchObject({
		displayName: "Name old",
		supportsImage: true,
		vendorId: "openai",
		vendorIcon: "https://www.flowstoken.com/brand/vendor-icons/openai.svg",
		vendorMono: true,
	});
	expect(getDefaultStore().get(localModelsConfigAtom)?.providers["flowstoken-default"].models).toHaveLength(2);
});

it("refreshes a continuously mounted picker within a minute, removing old models and preserving server order", async () => {
	const { result } = renderHook(() => {
		useModelCatalogSync();
		return useModelOptions();
	});
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	live = catalog(["new-z", "new-a"], "second");
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60 * 1000);
	});
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["new-z", "new-a"]));
	expect(getDefaultStore().get(flowstokenCatalogAtom)?.pricingVersion).toBe("second");
	expect(getCatalog).toHaveBeenCalledTimes(2);
	await act(async () => {
		window.dispatchEvent(new Event("focus"));
	});
	expect(getCatalog).toHaveBeenCalledTimes(2);
});

it("keeps both existing sources when a later catalog refresh fails", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	getCatalog.mockRejectedValueOnce(new Error("offline"));
	vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
	await act(async () => {
		await revalidateFlowstokenCatalog();
	});
	expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]);
	expect(getDefaultStore().get(flowstokenCatalogAtom)?.pricingVersion).toBe("first");
});

it("respects an explicit text-only override instead of forcing the catalog vision badge", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	await act(async () => {
		getDefaultStore().set(localModelsConfigAtom, {
			providers: { "flowstoken-default": { models: [{ id: "old", input: ["text"] }] } },
		});
	});
	expect(result.current.options[0].supportsImage).toBe(false);
});

it("applies a valid empty catalog atomically instead of keeping retired choices", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	live = { ...live, schema: 2, revision: "empty", groups: [] };
	await act(async () => {
		await revalidateFlowstokenCatalog(Date.now(), { force: true });
	});
	expect(result.current.options).toEqual([]);
	expect(getDefaultStore().get(flowstokenCatalogAtom)?.groups).toEqual([]);
});

it("adds, renames and reorders a group from the website catalog while preserving BYOK settings", async () => {
	const { result } = renderHook(() => useModelOptions());
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["old"]));
	const first = catalog(["z-last", "a-first"], "second");
	live = {
		...first,
		schema: 2,
		revision: "research",
		groups: [
			{
				...first.groups[0],
				id: "Research",
				providerId: "flowstoken-group-Research",
				title: "研究组",
				defaultModel: "z-last",
			},
			{ ...first.groups[0], title: "日常精选" },
		],
	};
	await act(async () => {
		await revalidateFlowstokenCatalog(Date.now(), { force: true });
	});
	expect([...result.current.grouped.keys()]).toEqual(["flowstoken-group-Research", "flowstoken-default"]);
	expect(result.current.labelFor("flowstoken-group-Research")).toBe("研究组");
	expect(result.current.grouped.get("flowstoken-group-Research")?.map((m) => m.modelId)).toEqual([
		"z-last",
		"a-first",
	]);
	await act(async () => {
		getDefaultStore().set(localModelsConfigAtom, {
			...config,
			providers: {
				...config.providers,
				personal: { api: "openai-completions", models: [{ id: "private-custom", name: "My model" }] },
			},
		});
	});
	expect(result.current.options.find((o) => o.key === "personal/private-custom")?.displayName).toBe("My model");
});

it("uses the paired IPC and publishes both atoms as one observable snapshot", async () => {
	const next = catalog(["paired"], "paired");
	const nextConfig: ModelsConfigData = { providers: { "flowstoken-default": { models: [{ id: "paired" }] } } };
	getCatalogSnapshot.mockResolvedValueOnce({ catalog: next, config: nextConfig });
	const store = getDefaultStore();
	const observed: string[][] = [];
	const dispose = store.sub(localModelsConfigAtom, () =>
		observed.push([
			store.get(localModelsConfigAtom)?.providers["flowstoken-default"].models?.[0].id ?? "",
			store.get(flowstokenCatalogAtom)?.pricingVersion ?? "",
		]),
	);
	await revalidateFlowstokenCatalog(Date.now(), { force: true });
	dispose();
	expect(observed).toEqual([["paired", "paired"]]);
	expect(get).not.toHaveBeenCalled();
	expect(getCatalog).not.toHaveBeenCalled();
});

it("re-reads a late paired response instead of erasing a newer BYOK settings write", async () => {
	const old = deferred<{ catalog: FlowstokenCatalog; config: ModelsConfigData }>();
	const nextConfig: ModelsConfigData = { providers: { personal: { models: [{ id: "saved-personal" }] } } };
	const latest = catalog(["new"], "new");
	getCatalogSnapshot
		.mockImplementationOnce(() => old.promise)
		.mockResolvedValueOnce({ catalog: latest, config: nextConfig });
	const pending = revalidateFlowstokenCatalog(Date.now(), { force: true });
	getDefaultStore().set(localModelsConfigAtom, nextConfig);
	old.resolve({ catalog: live, config });
	await pending;
	expect(getDefaultStore().get(localModelsConfigAtom)?.providers.personal.models?.[0].id).toBe("saved-personal");
	expect(getDefaultStore().get(flowstokenCatalogAtom)?.pricingVersion).toBe("new");
});

it("keeps a force caller's failure when it joins a background refresh", async () => {
	const failure = deferred<{ catalog: FlowstokenCatalog; config: ModelsConfigData }>();
	getCatalogSnapshot.mockImplementationOnce(() => failure.promise);
	const background = revalidateFlowstokenCatalog();
	const force = revalidateFlowstokenCatalog(Date.now(), { force: true });
	const assertion = expect(force).rejects.toThrow("offline");
	failure.reject(new Error("offline"));
	await Promise.all([background, assertion]);
});

it("keeps a force caller attached to a replacement read after its account generation changes", async () => {
	const old = deferred<{ catalog: FlowstokenCatalog; config: ModelsConfigData }>();
	getCatalogSnapshot.mockImplementationOnce(() => old.promise).mockRejectedValueOnce(new Error("New account offline"));
	const force = revalidateFlowstokenCatalog(Date.now(), { force: true });
	const assertion = expect(force).rejects.toThrow("New account offline");
	invalidateFlowstokenCatalog();
	await revalidateFlowstokenCatalog();
	// The replacement has already settled before the old IPC returns.
	old.resolve({ catalog: live, config });
	await assertion;
	expect(getCatalogSnapshot).toHaveBeenCalledTimes(2);
});

it("absorbs reconciliation's own model event without an endless refresh loop", async () => {
	let onModels!: Parameters<typeof window.vetta.models.onChanged>[0];
	const firstLocal = deferred<ModelsConfigData>();
	get.mockImplementationOnce(() => firstLocal.promise);
	window.vetta.models.onChanged = (listener) => {
		onModels = listener;
		return () => {};
	};
	getCatalogSnapshot.mockImplementationOnce(async () => {
		const next = await getCatalog();
		onModels({ providerIds: ["flowstoken-default"] });
		return { catalog: next, config };
	});
	const { result } = renderHook(() => {
		useModelCatalogSync();
		return useModelOptions();
	});
	await act(async () => {
		firstLocal.resolve(config);
		await firstLocal.promise;
	});
	await waitFor(() => expect(result.current.options.some((o) => o.modelId === "old")).toBe(true));
	expect(getCatalogSnapshot).toHaveBeenCalledTimes(1);
});

it("does not mistake a newer BYOK save event for the paired read's own reconciliation event", async () => {
	let onModels!: Parameters<typeof window.vetta.models.onChanged>[0];
	window.vetta.models.onChanged = (listener) => {
		onModels = listener;
		return () => {};
	};
	renderHook(() => useModelCatalogSync());
	await waitFor(() => expect(getDefaultStore().get(flowstokenCatalogAtom)).not.toBeNull());
	const previous = structuredClone(config);
	const old = deferred<{ catalog: FlowstokenCatalog; config: ModelsConfigData }>();
	getCatalogSnapshot.mockImplementationOnce(() => old.promise);
	const pending = revalidateFlowstokenCatalog(Date.now(), { force: true });
	const saved: ModelsConfigData = {
		...previous,
		providers: {
			...previous.providers,
			personal: { models: [{ id: "newly-saved-byok" }] },
		},
	};
	config = saved;
	getCatalogSnapshot.mockResolvedValueOnce({ catalog: live, config: saved });
	act(() => {
		onModels({ providerIds: ["personal"] });
	});
	await act(async () => {
		old.resolve({ catalog: live, config: previous });
		await pending;
	});
	expect(getDefaultStore().get(localModelsConfigAtom)?.providers.personal?.models?.[0].id).toBe("newly-saved-byok");
});

it("discards an old paired reply after a same-account authority event starts a new read", async () => {
	let onAccount!: Parameters<typeof window.vetta.flowstoken.onAccountChanged>[0];
	const old = deferred<{ catalog: FlowstokenCatalog; config: ModelsConfigData }>();
	const latest = catalog(["new"], "new");
	const nextConfig: ModelsConfigData = { providers: { "flowstoken-default": { models: [{ id: "new" }] } } };
	window.vetta.flowstoken.onAccountChanged = (listener) => {
		onAccount = listener;
		return () => {};
	};
	getCatalogSnapshot
		.mockImplementationOnce(() => old.promise)
		.mockResolvedValueOnce({ catalog: latest, config: nextConfig });
	const { result } = renderHook(() => {
		useModelCatalogSync();
		return useModelOptions();
	});
	await waitFor(() => expect(getCatalogSnapshot).toHaveBeenCalledTimes(1));
	await act(async () => {
		onAccount({ user: { id: 7 }, groups: [] } as never);
	});
	await waitFor(() => expect(result.current.options.map((o) => o.modelId)).toEqual(["new"]));
	await act(async () => {
		old.resolve({ catalog: live, config });
		await old.promise;
	});
	expect(result.current.options.map((o) => o.modelId)).toEqual(["new"]);
	expect(getDefaultStore().get(flowstokenCatalogAtom)?.pricingVersion).toBe("new");
});
