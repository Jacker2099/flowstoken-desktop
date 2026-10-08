// @vitest-environment jsdom
import type { ModelsConfigData } from "@preload/api";
import { localModelsConfigAtom } from "@shared/store/model-catalog";
import { showToast } from "@shared/store/toast-atoms";
import { act, renderHook } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelsSettingsModel } from "./useModelsSettingsModel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./recordSettingsUsage", () => ({ recordSettingsUsage: vi.fn() }));
vi.mock("@shared/store/toast-atoms", () => ({ showToast: vi.fn() }));
vi.mock("@shared/store/model-catalog", async () => {
	const { atom } = await import("jotai");
	return {
		localModelsConfigAtom: atom<ModelsConfigData>({
			providers: { local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen3" }] } },
		}),
		modelCatalog: { revalidate: vi.fn(async () => undefined) },
	};
});

beforeEach(() => {
	getDefaultStore().set(localModelsConfigAtom, {
		providers: { local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen3" }] } },
	});
});

it("keeps the default model and opaque credential reference when renaming its provider", async () => {
	getDefaultStore().set(localModelsConfigAtom, {
		defaultModel: "local/qwen3",
		providers: { local: {
			baseUrl: "http://localhost:11434/v1", apiKey: "***", credentialRef: "existing-private-key",
			models: [{ id: "qwen3" }],
		} },
	});
	const set = vi.fn(async () => undefined);
	Object.defineProperty(window, "vetta", { configurable: true, writable: true, value: { models: { set } } });
	const { result } = renderHook(() => useModelsSettingsModel());
	act(() => result.current.onStartEditProvider("local"));
	act(() => result.current.setProviderForm((form) => ({ ...form, name: "renamed" })));
	await act(() => result.current.onUpdateProvider("local"));
	expect(set).toHaveBeenCalledWith(expect.objectContaining({
		defaultModel: "renamed/qwen3",
		providers: { renamed: expect.objectContaining({ apiKey: "***", credentialRef: "existing-private-key" }) },
	}), { renameProvider: { from: "local", to: "renamed" } });
});

it("keeps the edited provider form open and reports a destination conflict without clearing the draft", async () => {
	Object.defineProperty(window, "vetta", { configurable: true, writable: true, value: { models: {
		set: vi.fn(async () => { throw new Error("MODEL_PROVIDER_RENAME_CONFLICT"); }),
	} } });
	const { result } = renderHook(() => useModelsSettingsModel());
	act(() => result.current.onStartEditProvider("local"));
	act(() => result.current.setProviderForm((form) => ({ ...form, name: "occupied" })));
	await act(() => result.current.onUpdateProvider("local"));
	expect(result.current.editingProvider).toBe("local");
	expect(result.current.providerForm.name).toBe("occupied");
	expect(result.current.saving).toBe(false);
	expect(showToast).toHaveBeenCalledWith({ variant: "error", message: "providerRenameConflict" });
});

describe("useModelsSettingsModel fetched models", () => {
	it("starts with nothing selected and supports select all / deselect all", async () => {
		const set = vi.fn(async () => undefined);
		(window as unknown as { vetta: unknown }).vetta = {
			models: {
				set,
				fetchProviderModels: vi.fn(async () => ({ models: ["qwen3", "llama3", "gemma3"] })),
			},
		};

		const { result } = renderHook(() => useModelsSettingsModel());
		await act(() => result.current.onFetchProviderModels("local"));
		expect(result.current.fetchedModels?.selected).toEqual([]);

		act(() => result.current.onSelectAllFetchedModels());
		// 已添加的 qwen3 不计入全选，避免计数虚高。
		expect(result.current.fetchedModels?.selected).toEqual(["llama3", "gemma3"]);

		act(() => result.current.onDeselectAllFetchedModels());
		expect(result.current.fetchedModels?.selected).toEqual([]);

		act(() => result.current.onToggleFetchedModel("gemma3"));
		await act(() => result.current.onApplyFetchedModels("local"));
		expect(set).toHaveBeenCalledWith({
			providers: {
				local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen3" }, { id: "gemma3" }] },
			},
		});
	});
});
