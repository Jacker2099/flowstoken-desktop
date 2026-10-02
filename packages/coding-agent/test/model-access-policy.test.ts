import type { Api, Model } from "@vetta/ai";
import { describe, expect, test, vi } from "vitest";
import { createCodingAgentModelRuntime, type ModelCredentialStore } from "../src/models/index.js";

const selected: Model<Api> = {
	id: "saved-model",
	provider: "managed",
	name: "Saved model",
	api: "openai-completions",
	baseUrl: "https://fixture.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
};

function credentials(getApiKey = vi.fn(async () => "fixture-key")): ModelCredentialStore {
	return {
		setFallbackResolver: () => {},
		get: () => undefined,
		hasAuth: () => true,
		getApiKey,
		getOAuthProviders: () => [],
	};
}

describe("model access policy at credential checkout", () => {
	test("rejects a saved model removed from the catalog before reading keys or requesting remote metadata", async () => {
		const getKey = vi.fn(async () => "fixture-key");
		const fetch = vi.fn<typeof globalThis.fetch>();
		const models = [selected];
		let enabled = true;
		const unavailable = Object.assign(new Error("Choose another model"), {
			code: "MODEL_UNAVAILABLE",
			modelKey: `${selected.provider}/${selected.id}`,
		});
		const runtime = createCodingAgentModelRuntime(credentials(getKey), {
			builtInModels: models,
			remoteSource: { fetch },
			validateModelAccess: async () => {
				if (!enabled) throw unavailable;
			},
		});
		expect(await runtime.getApiKey(selected)).toBe("fixture-key");
		models.splice(0);
		runtime.refresh();
		enabled = false;
		runtime.setServerUrl("https://fixture.invalid");
		runtime.setServerToken("fixture-server-token");
		fetch.mockResolvedValue(Response.json({ code: 0, data: { providers: {} } }));
		getKey.mockClear();
		await expect(runtime.getApiKey(selected)).rejects.toBe(unavailable);
		expect(getKey).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("rechecks the admitted account generation after asynchronous credential resolution", async () => {
		let started!: () => void;
		let finish!: (value: string) => void;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const key = new Promise<string>((resolve) => {
			finish = resolve;
		});
		let currentAccount = true;
		const runtime = createCodingAgentModelRuntime(
			credentials(
				vi.fn(() => {
					started();
					return key;
				}),
			),
			{
				builtInModels: [selected],
				validateModelAccess: async () => ({
					assertCurrent: () => {
						if (!currentAccount) throw new Error("account changed");
					},
				}),
			},
		);
		const checkout = runtime.getApiKey(selected).catch((error: unknown) => error);
		await reading;
		currentAccount = false;
		finish("fixture-old-account-key");
		expect(await checkout).toBeInstanceOf(Error);
	});

	test("applies the provider policy before direct provider credential reads", async () => {
		const getKey = vi.fn(async () => "fixture-key");
		const blocked = new Error("Group unavailable");
		const runtime = createCodingAgentModelRuntime(credentials(getKey), {
			builtInModels: [selected],
			validateProviderAccess: async () => {
				throw blocked;
			},
		});
		await expect(runtime.getApiKeyForProvider(selected.provider)).rejects.toBe(blocked);
		expect(getKey).not.toHaveBeenCalled();
	});

	test("keeps unconfigured hosts' credential behavior unchanged", async () => {
		const runtime = createCodingAgentModelRuntime(credentials(), { builtInModels: [selected] });
		expect(await runtime.getApiKey(selected)).toBe("fixture-key");
		expect(await runtime.getApiKeyForProvider(selected.provider)).toBe("fixture-key");
	});
});
