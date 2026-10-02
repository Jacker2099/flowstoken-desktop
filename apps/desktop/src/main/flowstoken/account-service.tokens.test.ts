import { beforeEach, expect, it, vi } from "vitest";
import type { ModelsConfig } from "../models/model-settings-service.js";
import { FLOWSTOKEN_GROUPS } from "./constants.js";
import type { NewApiTokenRow } from "./newapi-client.js";
import type { FlowstokenCatalog } from "./types.js";

const state = vi.hoisted(() => ({
	config: {
		providers: {},
		defaultModel: "flowstoken-smart/Bestoo-Auto",
	} as ModelsConfig,
	catalog: null as FlowstokenCatalog | null,
	allowed: { default: {}, smart: {}, vip: {} } as Record<string, object>,
	nextId: 10,
	tokens: [] as NewApiTokenRow[],
	requests: [] as Array<{ path: string; method: string; body?: string }>,
}));

vi.mock("electron", () => ({
	app: { getPath: () => "/nonexistent-flowstoken-token-test" },
	BrowserWindow: vi.fn(),
	net: { fetch: async () => (state.catalog ? Response.json(state.catalog) : new Response(null, { status: 503 })) },
	session: {
		fromPartition: () => ({
			cookies: { get: async () => [] },
			fetch: async (url: string, init: RequestInit) => {
				const path = new URL(url).pathname;
				state.requests.push({ path, method: init.method ?? "GET", body: init.body as string | undefined });
				let data: unknown;
				if (path === "/api/user/auth/refresh")
					data = { access_token: "fixture-access", user: { id: 7, username: "fixture" } };
				else if (path === "/api/user/self/groups") data = state.allowed;
				else if (path === "/api/token/" && init.method === "POST") {
					const input = JSON.parse(String(init.body)) as { name: string; group: string };
					state.tokens.push({ id: state.nextId++, ...input, status: 1 });
					data = {};
				} else if (path === "/api/token/") data = { items: state.tokens };
				else if (path === "/api/token/10/key") data = { key: "fixture-new-key" };
				else if (path === "/api/token/1/key") data = { key: "fixture-unsuitable-key" };
				else if (/^\/api\/token\/\d+\/key$/.test(path)) data = { key: `fixture-key-${path.split("/")[3]}` };
				else if (path === "/api/log/self") data = { items: [] };
				else throw new Error(`unexpected request: ${path}`);
				return Response.json({ success: true, data });
			},
		}),
	},
}));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("../models/model-settings-host.js", () => ({
	getDesktopModelSettingsService: () => ({
		getConfig: async () => structuredClone(state.config),
		updateConfig: async (
			update: (current: typeof state.config) => typeof state.config | undefined,
			beforeCommit?: () => void,
		) => {
			beforeCommit?.();
			const next = update(structuredClone(state.config));
			if (next) state.config = structuredClone(next);
		},
		replaceConfig: async (next: typeof state.config) => {
			state.config = structuredClone(next);
		},
	}),
}));

import { ensureGroupKeysAndProviders, getCatalogAndRefreshProviders } from "./account-service.js";
import { resetCatalogAccessForTests } from "./catalog-access.js";
import { resetGroupCatalogCacheForTests } from "./group-catalog.js";
import { getFlowstokenSession } from "./login-window.js";
import { clearCachedAccessToken, managedTokenName, refreshAuth } from "./newapi-client.js";

beforeEach(() => {
	clearCachedAccessToken();
	resetGroupCatalogCacheForTests();
	resetCatalogAccessForTests();
	state.requests = [];
	state.catalog = null;
	state.allowed = { default: {}, smart: {}, vip: {} };
	state.nextId = 10;
	state.config = {
		defaultModel: "flowstoken-smart/Bestoo-Auto",
		providers: Object.fromEntries(
			FLOWSTOKEN_GROUPS.map((group) => [
				group.providerId,
				{
					apiKey: "fixture-existing-key",
					modelsSyncedAt: new Date().toISOString(),
					managedGroup: { source: "flowstoken", accountId: 7, groupId: group.id, tokenId: 1 },
				},
			]),
		),
	};
});

function dynamicCatalog(): FlowstokenCatalog {
	return {
		schema: 2,
		revision: "new-group",
		generated: 1,
		pricingVersion: "v",
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [
			{
				id: "default",
				providerId: "flowstoken-default",
				title: "Renamed default",
				subtitle: "",
				vendors: [
					{
						id: "test",
						name: "Test",
						icon: null,
						mono: false,
						models: [
							{
								id: "existing-chat",
								name: "Existing",
								released: null,
								tags: [],
								vision: false,
								image: false,
								kind: "chat",
							},
						],
					},
				],
			},
			{
				id: "Research-X",
				providerId: "flowstoken-group-Research-X",
				title: "Research",
				subtitle: "",
				defaultModel: "embed",
				vendors: [
					{
						id: "test",
						name: "Test",
						icon: null,
						mono: false,
						models: [
							{
								id: "embed",
								name: "Embedding",
								released: null,
								tags: [],
								vision: false,
								image: false,
								kind: "embedding",
							},
							{
								id: "new-chat",
								name: "New",
								released: null,
								tags: [],
								vision: true,
								image: false,
								kind: "chat",
								contextWindow: 200_000,
								maxTokens: 24_000,
								reasoning: true,
								reasoningLevels: ["low", "medium"],
								defaultReasoningLevel: "medium",
							},
						],
					},
				],
			},
		],
	};
}

it("hot-adds an authorized server group once without login, preserving the saved default and custom tuning", async () => {
	state.catalog = dynamicCatalog();
	state.allowed["Research-X"] = {};
	state.tokens = [];
	state.config.providers.custom = {
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-custom",
		models: [{ id: "mine" }],
	};
	state.config.providers["flowstoken-default"].models = [
		{ id: "existing-chat", contextWindow: 250_000, input: ["text"] },
	];
	const originalDefault = state.config.defaultModel;
	await refreshAuth(getFlowstokenSession());
	await Promise.all([getCatalogAndRefreshProviders({ force: true }), getCatalogAndRefreshProviders({ force: true })]);
	expect(state.tokens).toEqual([
		expect.objectContaining({ id: 10, name: managedTokenName("Research-X"), group: "Research-X", status: 1 }),
	]);
	expect(state.config.defaultModel).toBe(originalDefault);
	expect(state.config.providers.custom.apiKey).toBe("fixture-custom");
	expect(state.config.providers["flowstoken-default"].models?.[0].contextWindow).toBe(250_000);
	expect(state.config.providers["flowstoken-group-Research-X"].models).toEqual([
		expect.objectContaining({
			id: "new-chat",
			contextWindow: 200_000,
			maxTokens: 24_000,
			reasoningLevels: ["low", "medium"],
			defaultReasoningLevel: "medium",
		}),
	]);
	expect(state.requests.filter((request) => request.path === "/api/token/" && request.method === "POST")).toHaveLength(
		1,
	);
	state.catalog = {
		...state.catalog,
		revision: "rename",
		groups: state.catalog.groups.map((g) => (g.id === "Research-X" ? { ...g, title: "Renamed Research" } : g)),
	};
	await getCatalogAndRefreshProviders({ force: true });
	expect(state.tokens).toHaveLength(1);
	expect(state.tokens[0].name).toBe(managedTokenName("Research-X"));
});

it("does not grant a public catalog group or create its token when the account API denies it", async () => {
	state.catalog = dynamicCatalog();
	state.tokens = [];
	await refreshAuth(getFlowstokenSession());
	await getCatalogAndRefreshProviders({ force: true });
	expect(state.config.providers["flowstoken-group-Research-X"]).toBeUndefined();
	expect((await ensureGroupKeysAndProviders(["Research-X"])).ok).toBe(false);
	expect(state.tokens).toEqual([]);
	expect(state.requests.some((request) => request.method === "POST" && request.path === "/api/token/")).toBe(false);
});

it("keeps an explicit manual key override during automatic catalog synchronization", async () => {
	state.catalog = dynamicCatalog();
	state.tokens = [];
	state.allowed["Research-X"] = {};
	state.config.providers["flowstoken-group-Research-X"] = {
		apiKey: "fixture-manual",
		managedGroupOverride: true,
		models: [{ id: "manual" }],
	};
	await refreshAuth(getFlowstokenSession());
	await getCatalogAndRefreshProviders({ force: true });
	expect(state.config.providers["flowstoken-group-Research-X"].apiKey).toBe("fixture-manual");
	expect(state.config.providers["flowstoken-group-Research-X"].models).toEqual([{ id: "manual" }]);
	expect(state.tokens).toEqual([]);
});

it.each([
	{ group: "vip", status: 1 },
	{ group: "default", status: 2 },
])("creates and wires a usable token when the same-name token is unsuitable: %j", async (metadata) => {
	state.tokens = [{ id: 1, name: FLOWSTOKEN_GROUPS[0].tokenName, ...metadata }];
	const result = await ensureGroupKeysAndProviders(["default"]);
	expect(result.ok).toBe(true);
	expect(result.created).toEqual(["普通组"]);
	expect(state.tokens[0]).toEqual({ id: 1, name: FLOWSTOKEN_GROUPS[0].tokenName, ...metadata });
	expect(state.config.providers["flowstoken-default"].apiKey).toBe("sk-fixture-new-key");
	expect(state.requests.filter((request) => request.method === "POST" && request.path === "/api/token/")).toHaveLength(
		1,
	);
	expect(state.requests.some((request) => request.path === "/api/token/1/key")).toBe(false);

	const repeated = await ensureGroupKeysAndProviders(["default"]);
	expect(repeated.ok).toBe(true);
	expect(repeated.created).toEqual([]);
	expect(repeated.reused).toEqual(["普通组"]);
	expect(state.tokens).toHaveLength(2);
	expect(state.requests.filter((request) => request.method === "POST" && request.path === "/api/token/")).toHaveLength(
		1,
	);
});

it("concurrent login and recovery requests create only one managed token per group", async () => {
	state.tokens = [];
	const results = await Promise.all([
		ensureGroupKeysAndProviders(["default"]),
		ensureGroupKeysAndProviders(["default"]),
	]);
	expect(results.every((result) => result.ok)).toBe(true);
	expect(state.tokens).toHaveLength(1);
	expect(state.requests.filter((request) => request.method === "POST" && request.path === "/api/token/")).toHaveLength(
		1,
	);
	expect(state.config.providers["flowstoken-default"].apiKey).toBe("sk-fixture-new-key");
});
