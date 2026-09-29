import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	config: { providers: {} as Record<string, Record<string, unknown>>, defaultModel: "flowstoken-smart/Bestoo-Auto" },
	replaceConfig: vi.fn(),
	fetchSelf: vi.fn(),
	listTokens: vi.fn(),
}));

vi.mock("electron", () => ({
	net: { fetch: mocks.fetch },
	app: { getPath: () => "/nonexistent-ft-test-dir" },
}));
vi.mock("../models/model-settings-host.js", () => ({
	getDesktopModelSettingsService: () => ({
		getConfig: async () => structuredClone(mocks.config),
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
	fetchSelfLogs: async () => [],
	findManagedToken: (tokens: Array<{ id: number; name: string }>, group: string) =>
		tokens.find((t) => t.name.endsWith(group)),
	listTokens: mocks.listTokens,
	revealTokenKey: async (_s: unknown, id: number) => `sk-${id}`,
}));

const { getAccountSnapshot, ensureGroupKeysAndProviders } = await import("./account-service.js");
const { resetGroupCatalogCacheForTests } = await import("./group-catalog.js");

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
	mocks.fetch.mockImplementation(async () => ({
		ok: true,
		json: async () => makeCatalog(pricingVersion),
	}));
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

async function flushBackgroundWork() {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.clearAllMocks();
	resetGroupCatalogCacheForTests();
	mocks.listTokens.mockResolvedValue([]);
	mocks.fetchSelf.mockResolvedValue({});
});

describe("FlowsToken group model lists", () => {
	it("wires groups with catalog-ordered models, catalog display names and the smart default", async () => {
		respond();
		mocks.config = { providers: {}, defaultModel: "" };
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
			{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", api: "openai-completions" },
			{ id: "openai/gpt-6-sol", name: "GPT-6 Sol", api: "openai-completions" },
		]);
		expect(providers["flowstoken-smart"].models).toEqual([
			{ id: "Bestoo-Auto", name: "Bestoo-Auto", api: "openai-completions" },
		]);
		expect(providers["flowstoken-official"].apiKey).toBe("sk-3");
	});

	it("refreshes stale model lists of wired groups in the background, keeping keys", async () => {
		respond("pv-2");
		const stale = 7 * 60 * 60 * 1000;
		mocks.config = {
			defaultModel: "flowstoken-official/anthropic/claude-opus-5.5",
			providers: {
				"flowstoken-default": wiredProvider(stale, [{ id: "gpt-5.5" }]),
				"flowstoken-smart": wiredProvider(stale, [{ id: "Bestoo-Auto" }]),
				"flowstoken-official": wiredProvider(stale, [{ id: "openai/gpt-4o" }]),
			},
		};

		await getAccountSnapshot({ includeUsage: false });
		await flushBackgroundWork();

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
		mocks.config = {
			defaultModel: "flowstoken-smart/Bestoo-Auto",
			providers: {
				"flowstoken-default": wiredProvider(fresh, [{ id: "gpt-5.5" }]),
				"flowstoken-smart": wiredProvider(fresh, [{ id: "Bestoo-Auto" }]),
				"flowstoken-official": wiredProvider(fresh, [{ id: "openai/gpt-4o" }]),
			},
		};
		respond();
		await getAccountSnapshot({ includeUsage: false });
		await flushBackgroundWork();
		expect(mocks.replaceConfig).not.toHaveBeenCalled();

		mocks.config.providers["flowstoken-official"].modelsSyncedAt = new Date(0).toISOString();
		mocks.fetch.mockRejectedValue(new Error("offline"));
		await getAccountSnapshot({ includeUsage: false });
		await flushBackgroundWork();
		expect(mocks.replaceConfig).not.toHaveBeenCalled();
		expect(mocks.config.providers["flowstoken-official"].models).toEqual([{ id: "openai/gpt-4o" }]);
	});

	it("rewrites model lists when the catalog pricingVersion changed", async () => {
		const stale = 7 * 60 * 60 * 1000;
		// Same model ids as the catalog serves — only the version moved (names/order may differ server-side).
		mocks.config = {
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
		};
		respond("pv-9");

		await getAccountSnapshot({ includeUsage: false });
		await flushBackgroundWork();

		expect(mocks.replaceConfig).toHaveBeenCalledTimes(1);
		const official = mocks.config.providers["flowstoken-official"];
		expect(official.catalogVersion).toBe("pv-9");
		// Catalog display names replace the stale id-derived names.
		expect((official.models as Array<{ name: string }>).map((m) => m.name)).toEqual(["Claude Opus 5.5", "GPT-6 Sol"]);
	});
});
