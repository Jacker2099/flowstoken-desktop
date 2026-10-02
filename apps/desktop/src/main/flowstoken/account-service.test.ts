import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GroupCatalogModule from "./group-catalog.js";

const mocks = vi.hoisted(() => ({
	userDataDir: "",
	fetch: vi.fn(),
	fetchCatalog: vi.fn<typeof GroupCatalogModule.fetchCatalog>(),
	config: { providers: {} as Record<string, Record<string, unknown>>, defaultModel: "flowstoken-smart/Bestoo-Auto" },
	replaceConfig: vi.fn(),
	fetchSelf: vi.fn(),
	listTokens: vi.fn(),
	revealTokenKey: vi.fn(),
	authRevision: 0,
	fetchSelfLogs: vi.fn(),
	fetchUsableGroups: vi.fn(),
}));

vi.mock("electron", () => ({
	net: { fetch: mocks.fetch },
	app: {
		getPath: () => {
			if (!mocks.userDataDir) throw new Error("Account test userData fixture is not initialized");
			return mocks.userDataDir;
		},
	},
}));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("./group-catalog.js", async (importOriginal) => {
	const catalog = await importOriginal<typeof GroupCatalogModule>();
	mocks.fetchCatalog.mockImplementation(catalog.fetchCatalog);
	return { ...catalog, fetchCatalog: mocks.fetchCatalog };
});
vi.mock("../models/model-settings-host.js", () => ({
	getDesktopModelSettingsService: () => ({
		getConfig: async () => structuredClone(mocks.config),
		updateConfig: async (
			update: (current: typeof mocks.config) => typeof mocks.config | undefined,
			beforeCommit?: () => void,
		) => {
			beforeCommit?.();
			const next = update(structuredClone(mocks.config));
			if (next) {
				mocks.replaceConfig(next);
				mocks.config = structuredClone(next);
			}
		},
		replaceConfig: async (next: typeof mocks.config) => {
			mocks.replaceConfig(next);
			mocks.config = structuredClone(next);
		},
	}),
}));
vi.mock("./login-window.js", () => ({
	clearFlowstokenSession: vi.fn(),
	getFlowstokenSession: () => ({}),
	loginViaBrowserWindow: vi.fn(),
	loginWithPasswordAndTurnstile: vi.fn(),
	probeExistingSession: async () => ({
		id: 7,
		username: "u",
		displayName: "u",
		quota: 500_000,
		usedQuota: 0,
		requestCount: 0,
	}),
}));
vi.mock("./newapi-client.js", () => ({
	FlowstokenApiError: class extends Error {},
	createToken: vi.fn(),
	fetchSelf: mocks.fetchSelf,
	fetchSelfLogs: mocks.fetchSelfLogs,
	findManagedToken: (tokens: Array<{ id: number; name: string }>, group: string) =>
		tokens.find((t) => t.name.endsWith(group)),
	listTokens: mocks.listTokens,
	revealTokenKey: mocks.revealTokenKey,
	getFlowstokenAuthRevision: () => mocks.authRevision,
	getFlowstokenAccountId: () => 7,
	fetchUsableGroups: mocks.fetchUsableGroups,
	refreshAuth: async () => ({ user: { id: 7 }, accessToken: "fixture" }),
	managedTokenName: (id: string) => `FlowsToken-Desktop-${id}`,
}));

const { getAccountSnapshot, ensureGroupKeysAndProviders, getCatalogAndRefreshProviders } = await import(
	"./account-service.js"
);
const { resetGroupCatalogCacheForTests } = await import("./group-catalog.js");
const { resetCatalogAccessForTests } = await import("./catalog-access.js");

/** These cases start with keys already provisioned for the current account. */
function withBindings(config: typeof mocks.config): typeof mocks.config {
	return {
		...config,
		providers: Object.fromEntries(
			Object.entries(config.providers).map(([id, provider]) => {
				const groupId =
					id === "flowstoken-smart"
						? "smart"
						: id === "flowstoken-official"
							? "vip"
							: id === "flowstoken-default"
								? "default"
								: null;
				return [
					id,
					groupId && provider.apiKey
						? { ...provider, managedGroup: { source: "flowstoken", accountId: 7, groupId, tokenId: 1 } }
						: provider,
				];
			}),
		),
	};
}

const model = (id: string, name?: string) => ({
	id,
	name: name ?? id.slice(id.indexOf("/") + 1),
	released: null,
	tags: [],
	vision: false,
	image: false,
});
const vendor = (id: string, name: string, models: ReturnType<typeof model>[]) => ({
	id,
	name,
	icon: null,
	mono: false,
	models,
});

function makeCatalog(pricingVersion: string) {
	return {
		schema: 1,
		generated: 1790000000,
		pricingVersion,
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [
			{
				id: "smart",
				providerId: "flowstoken-smart",
				title: "智能组",
				subtitle: "",
				defaultModel: "Bestoo-Auto",
				vendors: [vendor("bestoo", "Bestoo AI", [model("Bestoo-Auto")])],
			},
			{
				id: "default",
				providerId: "flowstoken-default",
				title: "普通组",
				subtitle: "",
				vendors: [
					vendor("anthropic", "Anthropic", [model("claude-opus-5-5", "Claude Opus 5.5")]),
					vendor("openai", "OpenAI", [model("gpt-6-sol", "GPT-6 Sol")]),
					vendor("deepseek", "DeepSeek", [model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash")]),
				],
			},
			{
				id: "vip",
				providerId: "flowstoken-official",
				title: "官方组",
				subtitle: "",
				vendors: [
					vendor("anthropic", "Anthropic", [model("anthropic/claude-opus-5.5", "Claude Opus 5.5")]),
					vendor("openai", "OpenAI", [model("openai/gpt-6-sol", "GPT-6 Sol")]),
				],
			},
		],
	};
}

function respond(pricingVersion = "pv-1") {
	mocks.fetch.mockImplementation(async (url: string) =>
		url.includes("desktop-catalog-v2.json")
			? { ok: false, status: 404 }
			: {
					ok: true,
					json: async () => makeCatalog(pricingVersion),
				},
	);
}

function wiredProvider(syncedAgoMs: number, models: Array<{ id: string; name?: string }>) {
	return {
		apiKey: "sk-kept",
		baseUrl: "https://www.flowstoken.com/v1",
		displayName: "FlowsToken",
		models,
		modelsSyncedAt: new Date(Date.now() - syncedAgoMs).toISOString(),
	};
}

function nextConfigReplacement() {
	return new Promise<void>((resolve) => mocks.replaceConfig.mockImplementationOnce(() => resolve()));
}

async function finishCatalogRequests() {
	// The real fetch awaits both its disk read and its mkdir/write/rename sequence.
	await Promise.all(
		mocks.fetchCatalog.mock.results.map((result) => {
			if (result.type !== "return") throw new Error("Catalog request did not return its completion promise");
			return result.value;
		}),
	);
}

beforeEach(async () => {
	// An allegedly nonexistent absolute path can be writable on Windows. Each case owns a real cache root.
	mocks.userDataDir = await mkdtemp(join(tmpdir(), "flowstoken-account-test-"));
	vi.clearAllMocks();
	mocks.replaceConfig.mockReset();
	resetGroupCatalogCacheForTests();
	resetCatalogAccessForTests();
	mocks.listTokens.mockResolvedValue([]);
	mocks.fetchSelf.mockResolvedValue({ id: 7 });
	mocks.fetchUsableGroups.mockResolvedValue(new Set(["default", "smart", "vip"]));
	mocks.fetchSelfLogs.mockResolvedValue([]);
	mocks.revealTokenKey.mockImplementation(async (_s: unknown, id: number) => `sk-${id}`);
});

afterEach(async () => {
	const userDataDir = mocks.userDataDir;
	try {
		await finishCatalogRequests();
	} finally {
		if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
		mocks.userDataDir = "";
		resetGroupCatalogCacheForTests();
	}
});

describe("FlowsToken group model lists", () => {
	it("does not publish a previous user's snapshot when the account changes during usage loading", async () => {
		mocks.config = withBindings({
			defaultModel: "flowstoken-smart/Bestoo-Auto",
			providers: Object.fromEntries(
				["flowstoken-default", "flowstoken-smart", "flowstoken-official"].map((id) => [
					id,
					wiredProvider(1_000, []),
				]),
			),
		});
		let finish!: (value: unknown[]) => void;
		let started!: () => void;
		const loading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const usage = new Promise<unknown[]>((resolve) => {
			finish = resolve;
		});
		mocks.fetchSelfLogs.mockImplementationOnce(() => {
			started();
			return usage;
		});
		const snapshot = getAccountSnapshot().catch((error: unknown) => error);
		await loading;
		mocks.authRevision++;
		finish([]);
		expect(await snapshot).toBeInstanceOf(Error);
		expect(mocks.replaceConfig).not.toHaveBeenCalled();
	});

	it("does not wire an old account's revealed key after the login session changes", async () => {
		respond();
		mocks.config = withBindings({
			defaultModel: "flowstoken-smart/Bestoo-Auto",
			providers: Object.fromEntries(
				["flowstoken-default", "flowstoken-smart", "flowstoken-official"].map((id) => [
					id,
					wiredProvider(1_000, []),
				]),
			),
		});
		mocks.listTokens.mockResolvedValue([{ id: 1, name: "FlowsToken-Desktop-default" }]);
		let finish!: (key: string) => void;
		let started!: () => void;
		const revealed = new Promise<string>((resolve) => {
			finish = resolve;
		});
		const revealStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		mocks.revealTokenKey.mockImplementationOnce(() => {
			started();
			return revealed;
		});
		const preparing = ensureGroupKeysAndProviders(["default"]);
		await revealStarted;
		mocks.authRevision++;
		finish("sk-old-account");
		const result = await preparing;
		expect(result.ok).toBe(false);
		expect(mocks.config.providers["flowstoken-default"].apiKey).toBe("sk-kept");
		expect(mocks.replaceConfig).not.toHaveBeenCalled();
	});

	it("wires groups with catalog-ordered models, catalog display names and the smart default", async () => {
		respond();
		mocks.config = withBindings({ providers: {}, defaultModel: "" });
		mocks.listTokens.mockResolvedValue([
			{ id: 1, name: "FlowsToken-Desktop-default" },
			{ id: 2, name: "FlowsToken-Desktop-smart" },
			{ id: 3, name: "FlowsToken-Desktop-vip" },
		]);

		const result = await ensureGroupKeysAndProviders();

		expect(result.ok).toBe(true);
		expect(mocks.config.defaultModel).toBe("flowstoken-smart/Bestoo-Auto");
		const providers = mocks.config.providers;
		expect((providers["flowstoken-default"].models as Array<{ id: string }>).map((m) => m.id)).toEqual([
			"claude-opus-5-5",
			"gpt-6-sol",
			"deepseek-v4.1-flash",
		]);
		expect(providers["flowstoken-official"].models).toEqual([
			{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", api: "openai-completions", input: ["text"] },
			{ id: "openai/gpt-6-sol", name: "GPT-6 Sol", api: "openai-completions", input: ["text"] },
		]);
		expect(providers["flowstoken-smart"].models).toEqual([
			{ id: "Bestoo-Auto", name: "Bestoo-Auto", api: "openai-completions", input: ["text"] },
		]);
		expect(providers["flowstoken-official"].apiKey).toBe("sk-3");
	});

	it("refreshes stale model lists of wired groups in the background, keeping keys", async () => {
		respond("pv-2");
		const stale = 7 * 60 * 60 * 1000;
		mocks.config = withBindings({
			defaultModel: "flowstoken-official/anthropic/claude-opus-5.5",
			providers: {
				"flowstoken-default": wiredProvider(stale, [{ id: "gpt-5.5" }]),
				"flowstoken-smart": wiredProvider(stale, [{ id: "Bestoo-Auto" }]),
				"flowstoken-official": wiredProvider(stale, [{ id: "openai/gpt-4o" }]),
			},
		});

		const refreshed = nextConfigReplacement();
		await getAccountSnapshot({ includeUsage: false });
		await refreshed;
		expect(mocks.replaceConfig).toHaveBeenCalledTimes(1);
		const official = mocks.config.providers["flowstoken-official"];
		expect((official.models as Array<{ id: string }>).map((m) => m.id)).toEqual([
			"anthropic/claude-opus-5.5",
			"openai/gpt-6-sol",
		]);
		expect(official.apiKey).toBe("sk-kept");
		expect(mocks.config.defaultModel).toBe("flowstoken-official/anthropic/claude-opus-5.5");
	});

	it("leaves fresh lists alone and keeps what it has when the site is unreachable", async () => {
		const fresh = 60 * 60 * 1000;
		mocks.config = withBindings({
			defaultModel: "flowstoken-smart/Bestoo-Auto",
			providers: {
				"flowstoken-default": wiredProvider(fresh, [{ id: "gpt-5.5" }]),
				"flowstoken-smart": wiredProvider(fresh, [{ id: "Bestoo-Auto" }]),
				"flowstoken-official": wiredProvider(fresh, [{ id: "openai/gpt-4o" }]),
			},
		});
		respond();
		await getAccountSnapshot({ includeUsage: false });
		// The fresh branch only awaits the immediately resolved getConfig mock; it starts no I/O.
		expect(mocks.fetchCatalog).not.toHaveBeenCalled();
		// Catalog metadata is read even for fresh providers so server group changes are discoverable.
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
		expect(mocks.replaceConfig).not.toHaveBeenCalled();

		mocks.config.providers["flowstoken-official"].modelsSyncedAt = new Date(0).toISOString();
		await rm(join(mocks.userDataDir, "flowstoken"), { recursive: true, force: true });
		resetGroupCatalogCacheForTests();
		mocks.fetch.mockRejectedValue(new Error("offline"));
		await getAccountSnapshot({ includeUsage: false });
		expect(mocks.fetchCatalog).toHaveBeenCalledTimes(1);
		await finishCatalogRequests();
		expect(mocks.replaceConfig).not.toHaveBeenCalled();
		expect(mocks.config.providers["flowstoken-official"].models).toEqual([{ id: "openai/gpt-4o" }]);
	});

	it("rewrites model lists when the catalog pricingVersion changed", async () => {
		const stale = 7 * 60 * 60 * 1000;
		// Same model ids as the catalog serves — only the version moved (names/order may differ server-side).
		mocks.config = withBindings({
			defaultModel: "flowstoken-smart/Bestoo-Auto",
			providers: {
				"flowstoken-default": wiredProvider(stale, [
					{ id: "claude-opus-5-5", name: "claude-opus-5-5" },
					{ id: "gpt-6-sol", name: "gpt-6-sol" },
					{ id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
				]),
				"flowstoken-smart": wiredProvider(stale, [{ id: "Bestoo-Auto", name: "Bestoo-Auto" }]),
				"flowstoken-official": wiredProvider(stale, [
					{ id: "anthropic/claude-opus-5.5", name: "claude-opus-5.5" },
					{ id: "openai/gpt-6-sol", name: "gpt-6-sol" },
				]),
			},
		});
		respond("pv-9");

		const refreshed = nextConfigReplacement();
		await getAccountSnapshot({ includeUsage: false });
		await refreshed;
		expect(mocks.replaceConfig).toHaveBeenCalledTimes(1);
		const official = mocks.config.providers["flowstoken-official"];
		expect(official.catalogVersion).toBe("pv-9");
		// Catalog display names replace the stale id-derived names.
		expect((official.models as Array<{ name: string }>).map((m) => m.name)).toEqual(["Claude Opus 5.5", "GPT-6 Sol"]);
	});
});

describe("picker-driven catalog refresh", () => {
	it("honors a deliberately empty group instead of retaining removed models or reviving fallback models", async () => {
		const catalog = makeCatalog("pv-empty");
		catalog.groups[1].vendors = [];
		mocks.fetch.mockImplementation(async (url) =>
			url.includes("desktop-catalog-v2.json") ? { ok: false, status: 404 } : { ok: true, json: async () => catalog },
		);
		mocks.config = withBindings({
			defaultModel: "flowstoken-smart/Bestoo-Auto",
			providers: {
				"flowstoken-default": wiredProvider(1_000, [{ id: "removed" }]),
				"flowstoken-smart": wiredProvider(1_000, [{ id: "Bestoo-Auto" }]),
				"flowstoken-official": wiredProvider(1_000, [{ id: "openai/gpt-4o" }]),
			},
		});
		await getCatalogAndRefreshProviders();
		expect(mocks.config.providers["flowstoken-default"].models).toEqual([]);
		expect(mocks.config.providers["flowstoken-default"].apiKey).toBe("sk-kept");
		mocks.listTokens.mockResolvedValue([{ id: 1, name: "FlowsToken-Desktop-default" }]);
		expect((await ensureGroupKeysAndProviders(["default"])).ok).toBe(true);
		expect(mocks.config.providers["flowstoken-default"].models).toEqual([]);
	});

	it("updates a fresh wired provider from new server data without touching account tokens or custom tuning", async () => {
		const catalog = makeCatalog("pv-menu");
		catalog.groups[1].vendors[0].models[0].vision = true;
		mocks.fetch.mockImplementation(async (url) =>
			url.includes("desktop-catalog-v2.json") ? { ok: false, status: 404 } : { ok: true, json: async () => catalog },
		);
		mocks.config = withBindings({
			defaultModel: "custom/model",
			providers: {
				"flowstoken-default": {
					...wiredProvider(1_000, []),
					models: [
						{ id: "claude-opus-5-5", contextWindow: 250_000, reasoning: true, reasoningLevels: ["low", "high"] },
					],
					useProxy: false,
				},
				custom: { apiKey: "keep-custom", models: [{ id: "model", input: ["text"] }] },
			},
		});
		const result = await getCatalogAndRefreshProviders();
		expect(result.pricingVersion).toBe("pv-menu");
		const provider = mocks.config.providers["flowstoken-default"];
		expect(provider.apiKey).toBe("sk-kept");
		expect(provider.useProxy).toBe(false);
		expect((provider.models as Array<Record<string, unknown>>)[0]).toMatchObject({
			id: "claude-opus-5-5",
			name: "Claude Opus 5.5",
			input: ["text", "image"],
			contextWindow: 250_000,
			reasoning: true,
			reasoningLevels: ["low", "high"],
		});
		expect(mocks.config.providers.custom).toEqual({
			apiKey: "keep-custom",
			models: [{ id: "model", input: ["text"] }],
		});
		expect(mocks.config.defaultModel).toBe("custom/model");
		expect(mocks.fetchSelf).not.toHaveBeenCalled();
		expect(mocks.listTokens).not.toHaveBeenCalled();
		expect(mocks.config.providers["flowstoken-smart"]).toBeUndefined();
		await getCatalogAndRefreshProviders();
		expect(mocks.replaceConfig).toHaveBeenCalledTimes(1);
	});

	it("preserves an explicit input override through disk fallback and keeps providers when no catalog exists", async () => {
		mocks.config = withBindings({
			defaultModel: "flowstoken-default/claude-opus-5-5",
			providers: {
				"flowstoken-default": {
					...wiredProvider(1_000, []),
					models: [{ id: "claude-opus-5-5", input: ["text"] }],
				},
			},
		});
		const catalog = makeCatalog("pv-vision");
		catalog.groups[1].vendors[0].models[0].vision = true;
		mocks.fetch.mockImplementation(async (url) =>
			url.includes("desktop-catalog-v2.json") ? { ok: false, status: 404 } : { ok: true, json: async () => catalog },
		);
		await getCatalogAndRefreshProviders();
		expect((mocks.config.providers["flowstoken-default"].models as Array<Record<string, unknown>>)[0].input).toEqual([
			"text",
		]);
		const before = structuredClone(mocks.config);
		resetGroupCatalogCacheForTests();
		mocks.fetch.mockRejectedValue(new Error("offline"));
		mocks.replaceConfig.mockClear();
		const cachePath = join(mocks.userDataDir, "flowstoken", "desktop-catalog.json");
		expect(JSON.parse(await readFile(cachePath, "utf8")).pricingVersion).toBe("pv-vision");
		// Clearing memory preserves the production disk fallback; offline alone is not a cache miss.
		expect((await getCatalogAndRefreshProviders()).pricingVersion).toBe("pv-vision");
		expect(mocks.config).toEqual(before);
		expect(mocks.replaceConfig).not.toHaveBeenCalled();
		await rm(cachePath);
		resetGroupCatalogCacheForTests();
		expect((await getCatalogAndRefreshProviders()).pricingVersion).toBe("");
		expect(mocks.config).toEqual(before);
		expect(mocks.replaceConfig).not.toHaveBeenCalled();
	});
});
