import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	config: { providers: {} as Record<string, Record<string, unknown>>, defaultModel: "flowstoken-smart/Bestoo-Auto" },
	replaceConfig: vi.fn(),
	fetchSelf: vi.fn(),
	listTokens: vi.fn(),
}));

vi.mock("electron", () => ({ net: { fetch: mocks.fetch } }));
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

const day = 24 * 60 * 60;
const pricing = {
	vendors: [
		{ id: 1, name: "OpenAI" },
		{ id: 2, name: "Anthropic" },
		{ id: 3, name: "DeepSeek" },
	],
	data: [
		{
			model_name: "deepseek-v4.1-flash",
			vendor_id: 3,
			model_ratio: 0.1,
			completion_ratio: 3,
			enable_groups: ["default"],
		},
		{ model_name: "gpt-6-sol", vendor_id: 1, model_ratio: 0.75, completion_ratio: 8, enable_groups: ["default"] },
		{
			model_name: "claude-opus-5-5",
			vendor_id: 2,
			model_ratio: 2.5,
			completion_ratio: 5,
			enable_groups: ["default"],
		},
		{ model_name: "openai/gpt-6-sol", vendor_id: 1, model_ratio: 1, completion_ratio: 5, enable_groups: ["vip"] },
		{
			model_name: "anthropic/claude-opus-5.5",
			vendor_id: 2,
			model_ratio: 2.5,
			completion_ratio: 5,
			enable_groups: ["vip"],
		},
		{ model_name: "Bestoo-Auto", vendor_id: 9, model_ratio: 2, completion_ratio: 4, enable_groups: ["smart"] },
	],
};

function respond(released: Record<string, number>) {
	mocks.fetch.mockImplementation(async (url: string) => ({
		ok: true,
		json: async () => (url.endsWith("/api/pricing") ? pricing : { models: released }),
	}));
}

function wiredProvider(syncedAgoMs: number, models: Array<{ id: string }>) {
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
	it("wires groups with models ordered by vendor, display names without routing prefix, smart as default", async () => {
		const now = Math.floor(Date.now() / 1000);
		respond({
			"claude-opus-5-5": now - 3 * day,
			"anthropic/claude-opus-5.5": now - 3 * day,
			"gpt-6-sol": now - 60 * day,
		});
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
			{ id: "anthropic/claude-opus-5.5", name: "claude-opus-5.5", api: "openai-completions" },
			{ id: "openai/gpt-6-sol", name: "gpt-6-sol", api: "openai-completions" },
		]);
		expect(providers["flowstoken-smart"].models).toEqual([
			{ id: "Bestoo-Auto", name: "Bestoo-Auto", api: "openai-completions" },
		]);
		expect(providers["flowstoken-official"].apiKey).toBe("sk-3");
	});

	it("refreshes stale model lists of wired groups in the background, keeping keys", async () => {
		respond({});
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
		respond({});
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
});
