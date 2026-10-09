import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
	userDataDir: "",
	writeFailure: false,
	writes: 0,
	keyFailure: null as { status?: number; remaining: number; retryAfter?: string; network?: boolean } | null,
	authStatus: 200,
	userId: 7,
}));

vi.mock("electron", () => ({
	app: { getPath: () => state.userDataDir },
	BrowserWindow: vi.fn(),
	net: { fetch: async () => (state.catalog ? Response.json(state.catalog) : new Response(null, { status: 503 })) },
	session: {
		fromPartition: () => ({
			cookies: { get: async () => [] },
			fetch: async (url: string, init: RequestInit) => {
				const path = new URL(url).pathname;
				state.requests.push({ path, method: init.method ?? "GET", body: init.body as string | undefined });
				if (path === "/api/user/auth/refresh" && state.authStatus === 401)
					return Response.json({ success: false, message: "Session expired" }, { status: 401 });
				if (/^\/api\/token\/\d+\/key$/.test(path) && state.keyFailure && state.keyFailure.remaining > 0) {
					state.keyFailure.remaining--;
					if (state.keyFailure.network) throw new TypeError("fetch failed");
					if (state.keyFailure.status === 401) state.authStatus = 401;
					return Response.json(
						{ success: false, message: "Temporary key failure" },
						{
							status: state.keyFailure.status ?? 503,
							headers: state.keyFailure.retryAfter ? { "Retry-After": state.keyFailure.retryAfter } : {},
						},
					);
				}
				let data: unknown;
				if (path === "/api/user/auth/refresh")
					data = { access_token: "fixture-access", user: { id: state.userId, username: "fixture" } };
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
		getMetadataConfig: async () => structuredClone(state.config),
		updateMetadataConfig: async (
			update: (current: typeof state.config) => typeof state.config | undefined,
			beforeCommit?: () => void,
		) => {
			beforeCommit?.();
			state.writes += 1;
			if (state.writeFailure) throw new Error("Secure credential storage is unavailable");
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
import { resetGroupCatalogCacheForTests, setCatalogDiskPathForTests } from "./group-catalog.js";
import { getFlowstokenSession } from "./login-window.js";
import { clearCachedAccessToken, managedTokenName, refreshAuth } from "./newapi-client.js";

beforeEach(() => {
	state.userDataDir = mkdtempSync(join(tmpdir(), "flowstoken-account-token-"));
	setCatalogDiskPathForTests(null);
	clearCachedAccessToken();
	resetGroupCatalogCacheForTests();
	resetCatalogAccessForTests();
	state.requests = [];
	state.catalog = null;
	state.allowed = { default: {}, smart: {}, vip: {} };
	state.nextId = 10;
	state.tokens = [];
	state.writeFailure = false;
	state.writes = 0;
	state.keyFailure = null;
	state.authStatus = 200;
	state.userId = 7;
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

afterEach(() => {
	vi.useRealTimers();
	clearCachedAccessToken();
	resetGroupCatalogCacheForTests();
	resetCatalogAccessForTests();
	setCatalogDiskPathForTests(null);
	rmSync(state.userDataDir, { recursive: true, force: true });
	state.userDataDir = "";
});

function setupAutomaticRecovery(): void {
	vi.useFakeTimers();
	state.catalog = { ...dynamicCatalog(), groups: dynamicCatalog().groups.slice(0, 1) };
	state.allowed = { default: {} };
	delete state.config.providers["flowstoken-default"].apiKey;
	state.tokens = [{ id: 10, name: managedTokenName("default"), group: "default", status: 1 }];
}

function keyRequestCount(): number {
	return state.requests.filter((request) => request.path.endsWith("/key")).length;
}

it("automatically recovers on a later catalog refresh after Retry-After without a sync click", async () => {
	setupAutomaticRecovery();
	state.keyFailure = { status: 429, remaining: 1, retryAfter: "120" };
	const initial = await ensureGroupKeysAndProviders(["default"]);
	expect(initial.ok).toBe(false);
	expect(initial.snapshot?.loggedIn).toBe(true);
	expect(initial.snapshot?.lastError).toBeDefined();
	await vi.advanceTimersByTimeAsync(119_999);
	await getCatalogAndRefreshProviders({ force: true });
	expect(keyRequestCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	await getCatalogAndRefreshProviders({ force: true });
	expect(keyRequestCount()).toBe(2);
	const snapshot = await (await import("./account-service.js")).getAccountSnapshot({ includeUsage: false });
	expect(snapshot.groups.every((group) => group.wired)).toBe(true);
	expect(snapshot.lastError).toBeUndefined();
});

it("automatically retries a supported network failure on the next account refresh after backoff", async () => {
	setupAutomaticRecovery();
	state.keyFailure = { network: true, remaining: 1 };
	expect((await ensureGroupKeysAndProviders(["default"])).ok).toBe(false);
	const account = await import("./account-service.js");
	await vi.advanceTimersByTimeAsync(59_999);
	expect((await account.getAccountSnapshot({ includeUsage: false })).lastError).toBe("fetch failed");
	expect(keyRequestCount()).toBe(1);
	const completed = new Promise<void>((resolve) => {
		account.setSnapshotBroadcastListener((snapshot) => {
			if (snapshot.groups.every((group) => group.wired)) resolve();
		});
	});
	try {
		await vi.advanceTimersByTimeAsync(1);
		await account.getAccountSnapshot({ includeUsage: false });
		await completed;
		expect(keyRequestCount()).toBe(2);
		expect((await account.getAccountSnapshot({ includeUsage: false })).lastError).toBeUndefined();
	} finally {
		account.setSnapshotBroadcastListener(() => {});
	}
});

it("limits consecutive 503 recovery attempts across repeated refreshes and still allows an explicit retry", async () => {
	setupAutomaticRecovery();
	state.keyFailure = { status: 503, remaining: 99 };
	expect((await ensureGroupKeysAndProviders(["default"])).ok).toBe(false);
	for (const delay of [60_000, 120_000]) {
		await vi.advanceTimersByTimeAsync(delay);
		await Promise.all([
			getCatalogAndRefreshProviders({ force: true }),
			getCatalogAndRefreshProviders({ force: true }),
		]);
	}
	expect(keyRequestCount()).toBe(3);
	await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
	for (let index = 0; index < 3; index++) await getCatalogAndRefreshProviders({ force: true });
	expect(keyRequestCount()).toBe(3);
	const account = await import("./account-service.js");
	expect((await account.getAccountSnapshot({ includeUsage: false })).lastError).toBe("Temporary key failure");
	state.keyFailure = null;
	expect((await ensureGroupKeysAndProviders(["default"])).ok).toBe(true);
	expect(keyRequestCount()).toBe(4);
	expect((await account.getAccountSnapshot({ includeUsage: false })).lastError).toBeUndefined();
});

it("does not schedule key recovery after a genuine 401 invalidates the account", async () => {
	setupAutomaticRecovery();
	state.keyFailure = { status: 401, remaining: 1 };
	const result = await ensureGroupKeysAndProviders(["default"]);
	expect(result.ok).toBe(false);
	expect(result.snapshot?.loggedIn).toBe(false);
	await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
	await getCatalogAndRefreshProviders({ force: true });
	const account = await import("./account-service.js");
	expect((await account.getAccountSnapshot({ includeUsage: false })).loggedIn).toBe(false);
	expect(keyRequestCount()).toBe(1);
});

it("binds recovery to the current authenticated account after switching accounts", async () => {
	setupAutomaticRecovery();
	state.keyFailure = { status: 503, remaining: 1 };
	expect((await ensureGroupKeysAndProviders(["default"])).ok).toBe(false);
	clearCachedAccessToken();
	state.userId = 9;
	state.tokens = [{ id: 11, name: managedTokenName("default"), group: "default", status: 1 }];
	await refreshAuth(getFlowstokenSession());
	await getCatalogAndRefreshProviders({ force: true });
	expect(state.config.providers["flowstoken-default"].managedGroup).toMatchObject({ accountId: 9, tokenId: 11 });
	expect(state.config.providers["flowstoken-default"].apiKey).toBe("sk-fixture-key-11");
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

it("lets the catalog override managed model specs while keeping fields the catalog omits", async () => {
	state.catalog = dynamicCatalog();
	const catalogModel = state.catalog.groups[0]!.vendors[0]!.models[0]!;
	catalogModel.contextWindow = 200_000;
	catalogModel.maxTokens = 24_000;
	state.config.providers["flowstoken-default"] = {
		...state.config.providers["flowstoken-default"],
		models: [{ id: "existing-chat", name: "Existing", contextWindow: 250_000, maxTokens: 8_000 }],
	};
	await refreshAuth(getFlowstokenSession());
	await getCatalogAndRefreshProviders({ force: true });
	expect(state.config.providers["flowstoken-default"].models).toEqual([
		expect.objectContaining({ id: "existing-chat", contextWindow: 200_000, maxTokens: 24_000 }),
	]);
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

it("retains its own last complete disk catalog through an offline memory-cache reset", async () => {
	state.catalog = dynamicCatalog();
	await refreshAuth(getFlowstokenSession());
	const network = await getCatalogAndRefreshProviders({ force: true });
	expect(network.source).toBe("network");
	const savedPath = join(state.userDataDir, "flowstoken", "desktop-catalog-v2.json");
	expect(existsSync(savedPath)).toBe(true);
	const { source: _source, ...persisted } = network;
	expect(JSON.parse(readFileSync(savedPath, "utf8"))).toEqual(persisted);
	state.catalog = null;
	resetGroupCatalogCacheForTests();
	resetCatalogAccessForTests();
	const offline = await getCatalogAndRefreshProviders({ force: true });
	expect(offline).toEqual({ ...network, source: "cache" });
	expect(offline.groups[0].title).toBe("Renamed default");
});

it.each([
	{ group: "vip", status: 1 },
	{ group: "default", status: 2 },
])("creates and wires a usable token when the same-name token is unsuitable: %j", async (metadata) => {
	expect(existsSync(join(state.userDataDir, "flowstoken", "desktop-catalog-v2.json"))).toBe(false);
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

it("stops automatic key repair after a storage failure while keeping the account logged in", async () => {
	vi.useFakeTimers();
	const { getAccountSnapshot } = await import("./account-service.js");
	for (const provider of Object.values(state.config.providers)) delete provider.apiKey;
	state.writeFailure = true;
	const result = await ensureGroupKeysAndProviders();
	expect(result.ok).toBe(false);
	expect(result.snapshot?.loggedIn).toBe(true);
	const firstWrites = state.writes;
	const firstReveals = state.requests.filter((request) => request.path.endsWith("/key")).length;
	await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
	for (let index = 0; index < 3; index += 1) {
		const snapshot = await getAccountSnapshot();
		expect(snapshot.loggedIn).toBe(true);
		expect(snapshot.lastError).toBe("Secure credential storage is unavailable");
	}
	expect(state.writes).toBe(firstWrites);
	expect(state.requests.filter((request) => request.path.endsWith("/key"))).toHaveLength(firstReveals);
	state.writeFailure = false;
	expect((await ensureGroupKeysAndProviders()).ok).toBe(true);
	expect((await getAccountSnapshot()).lastError).toBeUndefined();
});
