import { expect, it, vi } from "vitest";
import { ModelSettingsService, type ModelsConfig } from "./model-settings-service.js";

function fixture(encrypted = true) {
	let config: ModelsConfig = {
		defaultModel: "personal/model/with/slashes",
		providers: {
			personal: {
				baseUrl: "https://fixture.invalid/v1",
				...(encrypted ? { credentialRef: "existing-ref" } : {}),
				headers: { Authorization: "Bearer fixture-header", Cookie: "fixture-cookie", "X-Region": "us" },
				models: [{ id: "model/with/slashes" }],
			},
		},
	};
	const keys = new Map(encrypted ? [["existing-ref", "fixture-key"]] : []);
	const before = structuredClone(config);
	const writeConfig = vi.fn(async (next: ModelsConfig) => {
		config = structuredClone(next);
	});
	const refreshRegistry = vi.fn(async () => {});
	const credentials = {
		isAvailable: vi.fn(() => true),
		has: (ref: string) => keys.has(ref),
		get: vi.fn((ref: string) => keys.get(ref)),
		set: vi.fn((ref: string, key: string) => {
			keys.set(ref, key);
		}),
		remove: vi.fn((ref: string) => {
			keys.delete(ref);
		}),
	};
	const service = new ModelSettingsService({
		readConfig: async () => structuredClone(config),
		writeConfig,
		refreshRegistry,
		credentials,
	});
	return {
		service,
		keys,
		credentials,
		writeConfig,
		refreshRegistry,
		before,
		config: () => config,
		request: async () => {
			const projected = await service.getRendererConfig();
			projected.providers.renamed = projected.providers.personal;
			delete projected.providers.personal;
			return projected;
		},
	};
}

it.each([true, false])(
	"atomically preserves opaque credentials and headers during rename (encrypted=%s)",
	async (encrypted) => {
		const f = fixture(encrypted);
		const request = await f.request();
		expect(request.providers.renamed.headers?.Authorization).toBe("***");
		await f.service.replaceConfig(request, { renameProvider: { from: "personal", to: "renamed" } });
		expect(f.config().providers.personal).toBeUndefined();
		expect(f.config().providers.renamed.headers).toEqual(f.before.providers.personal.headers);
		expect(f.config().defaultModel).toBe("renamed/model/with/slashes");
		if (encrypted) expect(f.config().providers.renamed.credentialRef).toBe("existing-ref");
		for (const fn of [f.credentials.get, f.credentials.set, f.credentials.remove, f.credentials.isAvailable])
			expect(fn).not.toHaveBeenCalled();
		expect(JSON.stringify(f.config())).not.toContain("***");
	},
);

it("does not replace an existing destination or mutate either provider on conflict", async () => {
	const f = fixture();
	const request = await f.request();
	await f.service.updateMetadataConfig((config) => ({
		...config,
		providers: { ...config.providers, renamed: { models: [{ id: "other" }] } },
	}));
	const before = structuredClone(f.config());
	await expect(
		f.service.replaceConfig(request, { renameProvider: { from: "personal", to: "renamed" } }),
	).rejects.toThrow("MODEL_PROVIDER_RENAME_CONFLICT");
	expect(f.config()).toEqual(before);
});

it.each(["write", "registry"])("keeps original configuration and keys when rename fails during %s", async (phase) => {
	const f = fixture();
	const request = await f.request();
	request.providers.renamed.apiKey = "fixture-replacement-key";
	if (phase === "write") f.writeConfig.mockRejectedValueOnce(new Error("fixture disk unavailable"));
	else f.refreshRegistry.mockRejectedValueOnce(new Error("fixture refresh unavailable"));
	await expect(
		f.service.replaceConfig(request, { renameProvider: { from: "personal", to: "renamed" } }),
	).rejects.toThrow("fixture");
	expect(f.config()).toEqual(f.before);
	expect(f.keys.get("existing-ref")).toBe("fixture-key");
});

it("rebases the rename on queued catalog/default updates without overwriting unrelated changes", async () => {
	const f = fixture();
	const request = await f.request();
	request.providers.renamed.baseUrl = "https://edited.fixture.invalid/v1";
	const update = f.service.updateMetadataConfig((config) => ({
		...config,
		defaultModel: "other/new",
		providers: {
			...config.providers,
			personal: { ...config.providers.personal, models: [{ id: "catalog-new" }] },
			other: { models: [{ id: "new" }] },
		},
	}));
	const rename = f.service.replaceConfig(request, { renameProvider: { from: "personal", to: "renamed" } });
	await Promise.all([update, rename]);
	expect(f.config().defaultModel).toBe("other/new");
	expect(f.config().providers.other.models).toEqual([{ id: "new" }]);
	expect(f.config().providers.renamed.models).toEqual([{ id: "catalog-new" }]);
	expect(f.config().providers.renamed.baseUrl).toBe("https://edited.fixture.invalid/v1");
	expect(f.config().providers.renamed.headers?.Authorization).toBe("Bearer fixture-header");
});

it("rejects a custom rename into a reserved official billing provider identity", async () => {
	const f = fixture();
	const request = await f.request();
	request.providers["flowstoken-official"] = request.providers.renamed;
	await expect(
		f.service.replaceConfig(request, { renameProvider: { from: "personal", to: "flowstoken-official" } }),
	).rejects.toThrow("MODEL_PROVIDER_RENAME_UNAVAILABLE");
	expect(f.config()).toEqual(f.before);
});
