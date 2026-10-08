import { DOMAIN_MODEL_CAPABILITIES } from "@vetta-org/capability-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ModelCredentialStore } from "./model-credential-store.js";
import { ModelSettingsService, type ModelsConfig } from "./model-settings-service.js";

function createConfig(): ModelsConfig {
	return {
		defaultModel: "openai/gpt-5",
		providers: {
			openai: {
				displayName: "OpenAI",
				credentialRef: "openai-credential",
				headers: { Authorization: "Bearer secret", "X-Region": "us" },
				models: [{ id: "gpt-5", reasoning: true }],
			},
		},
	};
}

function createCredentialStore(initial: Record<string, string> = {}): ModelCredentialStore & {
	values: Map<string, string>;
} {
	const values = new Map(Object.entries(initial));
	return {
		values,
		isAvailable: () => true,
		has: (credentialRef) => values.has(credentialRef),
		get: (credentialRef) => values.get(credentialRef),
		set: (credentialRef, value) => {
			values.set(credentialRef, value);
		},
		remove: (credentialRef) => {
			values.delete(credentialRef);
		},
	};
}

describe("ModelSettingsService", () => {
	it("does not unlock an older credential-store implementation without an optional process cache", async () => {
		const credentials = createCredentialStore({ "openai-credential": "fixture-key" });
		const read = vi.spyOn(credentials, "get");
		const availability = vi.spyOn(credentials, "isAvailable");
		const service = new ModelSettingsService({
			readConfig: async () => createConfig(),
			writeConfig: vi.fn(),
			refreshRegistry: vi.fn(),
			credentials,
		});
		await expect(service.getCachedProviderApiKey("openai")).resolves.toBeUndefined();
		expect(read).not.toHaveBeenCalled();
		expect(availability).not.toHaveBeenCalled();
	});

	it("masks renderer headers and preserves their real values through an ordinary edit/save", async () => {
		let config = createConfig();
		config.providers.openai.headers = {
			Authorization: "Bearer fixture-header-secret",
			Cookie: "fixture-session-secret",
			"X-Region": "us",
		};
		const credentials = createCredentialStore({ "openai-credential": "fixture-key" });
		const service = new ModelSettingsService({
			readConfig: async () => structuredClone(config),
			writeConfig: async (next) => {
				config = structuredClone(next);
			},
			refreshRegistry: async () => {},
			credentials,
		});
		const renderer = await service.getRendererConfig();
		expect(renderer.providers.openai.headers).toEqual({ Authorization: "***", Cookie: "***", "X-Region": "us" });
		expect(JSON.stringify(renderer)).not.toContain("fixture-header-secret");
		expect(JSON.stringify(renderer)).not.toContain("fixture-session-secret");
		renderer.providers.openai.displayName = "Personal OpenAI";
		renderer.providers.openai.headers = { authorization: "***", Cookie: "***", "X-Region": "eu" };
		await service.replaceConfig(renderer);
		const resolved = await service.getConfig();
		expect(resolved.providers.openai.apiKey).toBe("fixture-key");
		expect(resolved.providers.openai.headers).toEqual({
			authorization: "Bearer fixture-header-secret",
			Cookie: "fixture-session-secret",
			"X-Region": "eu",
		});
	});

	it.each(["replace", "delete", "empty"])("keeps an explicit sensitive header %s", async (change) => {
		let config = createConfig();
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials: createCredentialStore(),
		});
		const renderer = await service.getRendererConfig();
		const headers = renderer.providers.openai.headers;
		if (!headers) throw new Error("Header fixture is missing");
		if (change === "replace") headers.Authorization = "Bearer fixture-replaced";
		if (change === "delete") delete headers.Authorization;
		if (change === "empty") headers.Authorization = "";
		await service.replaceConfig(renderer);
		expect(config.providers.openai.headers?.Authorization).toBe(
			change === "replace" ? "Bearer fixture-replaced" : change === "empty" ? "" : undefined,
		);
	});

	it("does not persist a masked header placeholder that has no previous credential", async () => {
		let config: ModelsConfig = { providers: {} };
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials: createCredentialStore(),
		});
		await service.replaceConfig({
			providers: {
				personal: { apiKey: "***", headers: { Authorization: "***", "X-Api-Key": "***", "X-Region": "eu" } },
			},
		});
		expect(config.providers.personal.apiKey).toBeUndefined();
		expect(config.providers.personal.credentialRef).toBeUndefined();
		expect(config.providers.personal.headers).toEqual({ "X-Region": "eu" });
	});

	it("keeps a renderer snapshot read on the configuration queue until its synchronous projection finishes", async () => {
		let config = createConfig();
		let pauseNextRead = false;
		let notifyRead!: () => void;
		const reading = new Promise<void>((resolve) => {
			notifyRead = resolve;
		});
		let releaseRead!: () => void;
		const released = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const service = new ModelSettingsService({
			readConfig: async () => {
				const snapshot = structuredClone(config);
				if (pauseNextRead) {
					pauseNextRead = false;
					notifyRead();
					await released;
				}
				return snapshot;
			},
			writeConfig: async (next) => {
				config = structuredClone(next);
			},
			refreshRegistry: async () => {},
			credentials: createCredentialStore(),
		});
		await service.getRendererConfig();
		pauseNextRead = true;
		const snapshot = service.readRendererSnapshot((safe) => safe.providers.openai.displayName);
		await reading;
		let mutationDone = false;
		const mutation = service
			.updateConfig((latest) => ({
				...latest,
				providers: { ...latest.providers, openai: { ...latest.providers.openai, displayName: "Changed" } },
			}))
			.then(() => {
				mutationDone = true;
			});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(mutationDone).toBe(false);
		expect(config.providers.openai.displayName).toBe("OpenAI");
		releaseRead();
		expect(await snapshot).toBe("OpenAI");
		await mutation;
		expect(config.providers.openai.displayName).toBe("Changed");
	});

	it("refuses an asynchronous snapshot projection", async () => {
		const service = new ModelSettingsService({
			readConfig: async () => createConfig(),
			writeConfig: async () => {},
			refreshRegistry: async () => {},
			credentials: createCredentialStore(),
		});
		await expect(service.readRendererSnapshot(async () => "network result")).rejects.toThrow("must be synchronous");
	});

	it("does not accept an account binding forged by a renderer configuration", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "fixture-current" });
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
		});
		const incoming = await service.getRendererConfig();
		incoming.providers.openai.managedGroup = { source: "flowstoken", accountId: 999, groupId: "vip", tokenId: 8 };
		await service.replaceConfig(incoming);
		expect(config.providers.openai.managedGroup).toBeUndefined();
		expect(credentials.get("openai-credential")).toBe("fixture-current");
	});

	it.each(["key", "ref", "route"])(
		"invalidates an authenticated binding after a user changes the %s without resetting their input",
		async (change) => {
			let config = createConfig();
			config.providers.openai.baseUrl = "https://www.flowstoken.com/v1";
			config.providers.openai.managedGroup = { source: "flowstoken", accountId: 7, groupId: "default", tokenId: 10 };
			const credentials = createCredentialStore({ "openai-credential": "fixture-current", other: "fixture-other" });
			const service = new ModelSettingsService({
				readConfig: async () => config,
				writeConfig: async (next) => {
					config = next;
				},
				refreshRegistry: async () => {},
				credentials,
			});
			const incoming = await service.getRendererConfig();
			if (change === "key") incoming.providers.openai.apiKey = "fixture-manual";
			if (change === "ref") incoming.providers.openai.credentialRef = "other";
			if (change === "route") incoming.providers.openai.baseUrl = "https://fixture.invalid/v1";
			await service.replaceConfig(incoming);
			expect(config.providers.openai.managedGroup).toBeUndefined();
			expect(config.providers.openai.managedGroupOverride).toBe(true);
			if (change === "key") expect(await service.getProviderApiKey("openai")).toBe("fixture-manual");
			if (change === "ref") expect(await service.getProviderApiKey("openai")).toBe("fixture-other");
			if (change === "route") expect(config.providers.openai.baseUrl).toBe("https://fixture.invalid/v1");
		},
	);

	it("keeps the sealed account binding and key when renderer changes only model tuning", async () => {
		let config = createConfig();
		config.providers.openai.managedGroup = { source: "flowstoken", accountId: 7, groupId: "default", tokenId: 10 };
		const credentials = createCredentialStore({ "openai-credential": "fixture-current" });
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
		});
		const incoming = await service.getRendererConfig();
		incoming.providers.openai.managedGroup = { source: "flowstoken", accountId: 99, groupId: "vip", tokenId: 99 };
		incoming.providers.openai.models![0].contextWindow = 250_000;
		await service.replaceConfig(incoming);
		expect(config.providers.openai.managedGroup).toMatchObject({ accountId: 7, groupId: "default", tokenId: 10 });
		expect(config.providers.openai.models![0].contextWindow).toBe(250_000);
		expect(await service.getProviderApiKey("openai")).toBe("fixture-current");
	});

	it.each(["write", "registry"])(
		"rolls back a canceled account commit during %s without emitting the old update",
		async (phase) => {
			let config = createConfig();
			const original = structuredClone(config);
			const credentials = createCredentialStore({ "openai-credential": "fixture-current-account" });
			let blocked = false;
			let started!: () => void;
			let finish!: () => void;
			const commitStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const accessChanged = vi.fn();
			const configChanged = vi.fn();
			const registryKeys: Array<string | undefined> = [];
			const service = new ModelSettingsService({
				readConfig: async () => config,
				writeConfig: async (next) => {
					config = next;
					if (phase === "write" && !blocked) {
						blocked = true;
						started();
						await gate;
					}
				},
				refreshRegistry: async () => {
					registryKeys.push(credentials.get("openai-credential"));
					if (phase === "registry" && !blocked) {
						blocked = true;
						started();
						await gate;
					}
				},
				credentials,
				onProviderAccessChanged: accessChanged,
				onConfigChanged: configChanged,
			});
			await service.getConfig();
			let currentAccount = true;
			const updating = service
				.updateConfig(
					(latest) => ({
						...latest,
						providers: {
							...latest.providers,
							openai: { ...latest.providers.openai, apiKey: "fixture-canceled-account" },
						},
					}),
					() => {
						if (!currentAccount) throw new Error("account changed");
					},
				)
				.catch((error: unknown) => error);
			await commitStarted;
			currentAccount = false;
			finish();
			expect(await updating).toBeInstanceOf(Error);
			expect(config).toEqual(original);
			expect(credentials.get("openai-credential")).toBe("fixture-current-account");
			expect(accessChanged).not.toHaveBeenCalled();
			expect(configChanged).not.toHaveBeenCalled();
			if (phase === "registry") expect(registryKeys.at(-1)).toBe("fixture-current-account");
		},
	);

	it("cancels an account update after a queued config read before any key or file is written", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "fixture-current-account" });
		let readGate: Promise<ModelsConfig> | undefined;
		let started!: () => void;
		let finish!: (value: ModelsConfig) => void;
		const readStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const writeConfig = vi.fn(async (next: ModelsConfig) => {
			config = next;
		});
		const refreshRegistry = vi.fn(async () => {});
		const service = new ModelSettingsService({
			readConfig: async () => {
				if (readGate) {
					started();
					return readGate;
				}
				return config;
			},
			writeConfig,
			refreshRegistry,
			credentials,
		});
		await service.getConfig();
		readGate = new Promise((resolve) => {
			finish = resolve;
		});
		let currentAccount = true;
		const updating = service
			.updateConfig(
				(latest) => ({
					...latest,
					providers: {
						...latest.providers,
						openai: { ...latest.providers.openai, apiKey: "fixture-old-account" },
					},
				}),
				() => {
					if (!currentAccount) throw new Error("account changed");
				},
			)
			.catch((error: unknown) => error);
		await readStarted;
		currentAccount = false;
		finish(config);
		expect(await updating).toBeInstanceOf(Error);
		expect(writeConfig).not.toHaveBeenCalled();
		expect(refreshRegistry).not.toHaveBeenCalled();
		expect(credentials.get("openai-credential")).toBe("fixture-current-account");
	});

	it("applies concurrent catalog and credential updates to the latest queued config", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "fixture-old-key" });
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
		});
		await Promise.all([
			service.updateConfig((latest) => ({
				...latest,
				providers: {
					...latest.providers,
					openai: { ...latest.providers.openai, apiKey: "fixture-new-key", useProxy: false },
				},
			})),
			service.updateConfig((latest) => ({
				...latest,
				providers: { ...latest.providers, openai: { ...latest.providers.openai, models: [{ id: "new-model" }] } },
			})),
		]);
		expect((await service.getConfig()).providers.openai).toMatchObject({
			apiKey: "fixture-new-key",
			useProxy: false,
			models: [{ id: "new-model" }],
			displayName: "OpenAI",
		});
	});

	it("persists plugin reasoning choices through capability parsing and model read-back", async () => {
		let config: ModelsConfig = { providers: {} };
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials: createCredentialStore(),
		});
		const models = ["gpt-5.6-sol", "gpt-6-astra"].map((id) => ({
			id,
			reasoning: true,
			reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
			defaultReasoningLevel: "medium",
		}));
		const input = DOMAIN_MODEL_CAPABILITIES.REPLACE_OWNED_PROVIDERS.parseInput({
			owner: "cli-proxy-api",
			providers: { responses: { api: "openai-responses", models } },
		});
		await service.replaceOwnedProviders(input.owner, input.providers);
		expect(config.providers["cli-proxy-api.responses"]?.models).toEqual(models);
		const snapshot = DOMAIN_MODEL_CAPABILITIES.GET_PROVIDER.parseOutput(
			await service.getSanitizedProvider("cli-proxy-api.responses"),
		);
		expect(snapshot.models).toEqual(models);
		const restored = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials: createCredentialStore(),
		});
		expect((await restored.getRendererConfig()).providers["cli-proxy-api.responses"]?.models).toEqual(models);
	});

	it("returns masked renderer config and sanitized capability data", async () => {
		const credentials = createCredentialStore({ "openai-credential": "secret" });
		const service = new ModelSettingsService({
			readConfig: async () => createConfig(),
			writeConfig: vi.fn(),
			refreshRegistry: vi.fn(),
			credentials,
		});

		await expect(service.getRendererConfig()).resolves.toMatchObject({
			providers: { openai: { apiKey: "***", credentialRef: "openai-credential" } },
		});
		await expect(service.getSanitizedConfig()).resolves.toEqual({
			defaultModel: "openai/gpt-5",
			providers: {
				openai: {
					displayName: "OpenAI",
					apiKey: "***",
					headers: { Authorization: "***", "X-Region": "us" },
					models: [{ id: "gpt-5", reasoning: true }],
				},
			},
		});
		await expect(service.getProviderApiKey("openai")).resolves.toBe("secret");
		await expect(service.getProviderApiKey("missing")).resolves.toBeUndefined();
	});

	it("keeps an encrypted key when renderer sends the mask", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "secret" });
		const writeConfig = vi.fn<(next: ModelsConfig) => Promise<void>>(async (next) => {
			config = next;
		});
		const refreshRegistry = vi.fn<() => Promise<void>>(async () => {});
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig,
			refreshRegistry,
			credentials,
		});

		const renderer = await service.getRendererConfig();
		renderer.providers.openai = {
			...renderer.providers.openai,
			displayName: "OpenAI Updated",
		};
		await service.replaceConfig(renderer);

		expect(config.providers.openai).toMatchObject({
			displayName: "OpenAI Updated",
			credentialRef: "openai-credential",
		});
		expect(config.providers.openai?.apiKey).toBeUndefined();
		expect(credentials.values.get("openai-credential")).toBe("secret");
		expect(refreshRegistry).toHaveBeenCalledOnce();
	});

	it("keeps an encrypted key when a capability updates provider metadata", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "secret" });
		const onProviderAccessChanged = vi.fn();
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
			onProviderAccessChanged,
		});

		await expect(
			service.upsertProvider("openai", {
				displayName: "OpenAI Updated",
				models: [{ id: "gpt-5.1", reasoning: true }],
			}),
		).resolves.toMatchObject({
			displayName: "OpenAI Updated",
			apiKey: "***",
			models: [{ id: "gpt-5.1", reasoning: true }],
		});
		expect(config.providers.openai?.credentialRef).toBe("openai-credential");
		expect(config.providers.openai?.apiKey).toBeUndefined();
		expect(credentials.values.get("openai-credential")).toBe("secret");
		expect(onProviderAccessChanged).not.toHaveBeenCalled();
	});

	it("atomically replaces only one plugin namespace and clears its default", async () => {
		let config: ModelsConfig = {
			defaultModel: "cli-proxy-api.google/gemini-test",
			providers: {
				"cli-proxy-api.google": { api: "google-generative-ai", models: [{ id: "old" }] },
				"cli-proxy-api.anthropic": { api: "anthropic-messages", models: [{ id: "stale" }] },
				openai: { api: "openai-responses", models: [{ id: "gpt-5" }] },
			},
		};
		const writeConfig = vi.fn<(next: ModelsConfig) => Promise<void>>(async (next) => {
			config = next;
		});
		const refreshRegistry = vi.fn<() => Promise<void>>(async () => {});
		const onConfigChanged = vi.fn();
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig,
			refreshRegistry,
			credentials: createCredentialStore(),
			onConfigChanged,
		});

		await service.replaceOwnedProviders("cli-proxy-api", {
			google: { api: "google-generative-ai", models: [{ id: "new" }] },
		});

		expect(config).toEqual({
			providers: {
				"cli-proxy-api.google": { api: "google-generative-ai", models: [{ id: "new" }] },
				openai: { api: "openai-responses", models: [{ id: "gpt-5" }] },
			},
		});
		expect(writeConfig).toHaveBeenCalledOnce();
		expect(refreshRegistry).toHaveBeenCalledOnce();
		expect(onConfigChanged).toHaveBeenCalledWith(expect.arrayContaining(["cli-proxy-api.google", "openai"]));
	});

	it("keeps the plugin-owned default model when the replacement still publishes it", async () => {
		let config: ModelsConfig = {
			defaultModel: "cli-proxy-api.google/gemini-test",
			providers: {
				"cli-proxy-api.google": { api: "google-generative-ai", models: [{ id: "gemini-test" }] },
			},
		};
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials: createCredentialStore(),
		});

		await service.replaceOwnedProviders("cli-proxy-api", {
			google: { api: "google-generative-ai", models: [{ id: "gemini-test" }, { id: "gemini-new" }] },
		});

		expect(config.defaultModel).toBe("cli-proxy-api.google/gemini-test");
	});

	it("reads back one plugin namespace by local id with credentials redacted", async () => {
		const config: ModelsConfig = {
			providers: {
				"cli-proxy-api.google": {
					api: "google-generative-ai",
					apiKey: "gateway-secret",
					headers: { Authorization: "Bearer gateway-secret" },
					models: [{ id: "gemini-test" }],
				},
				"other-plugin.google": { api: "google-generative-ai", models: [{ id: "not-mine" }] },
				openai: { api: "openai-responses", models: [{ id: "gpt-5" }] },
			},
		};
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: vi.fn(),
			refreshRegistry: vi.fn(),
			credentials: createCredentialStore(),
		});

		await expect(service.listOwnedProviders("cli-proxy-api")).resolves.toEqual({
			google: {
				api: "google-generative-ai",
				apiKey: "***",
				headers: { Authorization: "***" },
				models: [{ id: "gemini-test" }],
			},
		});
	});

	it("replaces and clears an encrypted key without writing plaintext", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "secret" });
		const onProviderAccessChanged = vi.fn();
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
			onProviderAccessChanged,
		});

		const replacement = await service.getRendererConfig();
		replacement.providers.openai.apiKey = "replacement-secret";
		await service.replaceConfig(replacement);

		expect(config.providers.openai?.apiKey).toBeUndefined();
		expect(credentials.values.get("openai-credential")).toBe("replacement-secret");

		const cleared = await service.getRendererConfig();
		delete cleared.providers.openai.apiKey;
		await service.replaceConfig(cleared);

		expect(config.providers.openai?.credentialRef).toBeUndefined();
		expect(credentials.values.has("openai-credential")).toBe(false);
		expect(onProviderAccessChanged).toHaveBeenNthCalledWith(1, ["openai"]);
		expect(onProviderAccessChanged).toHaveBeenNthCalledWith(2, ["openai"]);
	});

	it("keeps an encrypted key when its provider is renamed", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "secret" });
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
		});

		const renderer = await service.getRendererConfig();
		renderer.providers.customOpenai = renderer.providers.openai;
		delete renderer.providers.openai;
		await service.replaceConfig(renderer);

		expect(config.providers.customOpenai).toMatchObject({ credentialRef: "openai-credential" });
		expect(credentials.values.get("openai-credential")).toBe("secret");
	});

	it("keeps metadata reads side-effect free and migrates legacy plaintext during an explicit credential read", async () => {
		let config: ModelsConfig = {
			providers: { openai: { apiKey: "sk-legacy", models: [{ id: "gpt-5" }] } },
		};
		const credentials = createCredentialStore();
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
		});

		const renderer = await service.getRendererConfig();
		expect(config.providers.openai?.apiKey).toBe("sk-legacy");
		expect(credentials.values.size).toBe(0);
		await service.getConfig();
		const credentialRef = config.providers.openai?.credentialRef;

		expect(credentialRef).toBeTypeOf("string");
		expect(config.providers.openai?.apiKey).toBeUndefined();
		expect(credentials.values.get(credentialRef as string)).toBe("sk-legacy");
		expect(renderer.providers.openai?.apiKey).toBe("***");
		await expect(service.getConfig()).resolves.toMatchObject({
			providers: { openai: { apiKey: "sk-legacy" } },
		});
	});

	it("clears the encrypted credential with a removed provider", async () => {
		let config = createConfig();
		const credentials = createCredentialStore({ "openai-credential": "secret" });
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig: async (next) => {
				config = next;
			},
			refreshRegistry: async () => {},
			credentials,
		});

		await service.removeProvider("openai");

		expect(config).toEqual({ providers: {} });
		expect(credentials.values.has("openai-credential")).toBe(false);
	});

	it("treats removing an absent provider as an idempotent no-op", async () => {
		const config: ModelsConfig = { providers: {} };
		const writeConfig = vi.fn<(next: ModelsConfig) => Promise<void>>(async () => {});
		const refreshRegistry = vi.fn<() => Promise<void>>(async () => {});
		const credentials = createCredentialStore();
		const service = new ModelSettingsService({
			readConfig: async () => config,
			writeConfig,
			refreshRegistry,
			credentials,
		});

		await expect(service.removeProvider("cli-proxy-api.google")).resolves.toBeUndefined();

		expect(writeConfig).not.toHaveBeenCalled();
		expect(refreshRegistry).not.toHaveBeenCalled();
		expect(credentials.values).toEqual(new Map());
	});
});
