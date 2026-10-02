import { beforeEach, expect, it, vi } from "vitest";
import { FLOWSTOKEN_GROUPS } from "./constants.js";
import type { NewApiTokenRow } from "./newapi-client.js";

const state = vi.hoisted(() => ({
	config: {
		providers: {} as Record<string, { apiKey?: string; modelsSyncedAt?: string }>,
		defaultModel: "flowstoken-smart/Bestoo-Auto",
	},
	tokens: [] as NewApiTokenRow[],
	requests: [] as Array<{ path: string; method: string; body?: string }>,
}));

vi.mock("electron", () => ({
	app: { getPath: () => "/nonexistent-flowstoken-token-test" },
	BrowserWindow: vi.fn(),
	net: { fetch: async () => new Response(null, { status: 503 }) },
	session: {
		fromPartition: () => ({
			cookies: { get: async () => [] },
			fetch: async (url: string, init: RequestInit) => {
				const path = new URL(url).pathname;
				state.requests.push({ path, method: init.method ?? "GET", body: init.body as string | undefined });
				let data: unknown;
				if (path === "/api/user/auth/refresh")
					data = { access_token: "fixture-access", user: { id: 7, username: "fixture" } };
				else if (path === "/api/token/" && init.method === "POST") {
					const input = JSON.parse(String(init.body)) as { name: string; group: string };
					state.tokens.push({ id: 10, ...input, status: 1 });
					data = {};
				} else if (path === "/api/token/") data = { items: state.tokens };
				else if (path === "/api/token/10/key") data = { key: "fixture-new-key" };
				else if (path === "/api/token/1/key") data = { key: "fixture-unsuitable-key" };
				else if (path === "/api/log/self") data = { items: [] };
				else throw new Error(`unexpected request: ${path}`);
				return Response.json({ success: true, data });
			},
		}),
	},
}));
vi.mock("../models/model-settings-host.js", () => ({
	getDesktopModelSettingsService: () => ({
		getConfig: async () => structuredClone(state.config),
		replaceConfig: async (next: typeof state.config) => {
			state.config = structuredClone(next);
		},
	}),
}));

import { ensureGroupKeysAndProviders } from "./account-service.js";
import { resetGroupCatalogCacheForTests } from "./group-catalog.js";
import { clearCachedAccessToken } from "./newapi-client.js";

beforeEach(() => {
	clearCachedAccessToken();
	resetGroupCatalogCacheForTests();
	state.requests = [];
	state.config = {
		defaultModel: "flowstoken-smart/Bestoo-Auto",
		providers: Object.fromEntries(
			FLOWSTOKEN_GROUPS.map((group) => [
				group.providerId,
				{
					apiKey: "fixture-existing-key",
					modelsSyncedAt: new Date().toISOString(),
				},
			]),
		),
	};
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
	expect(state.requests.filter((request) => request.method === "POST" && request.path === "/api/token/")).toHaveLength(1);
	expect(state.config.providers["flowstoken-default"].apiKey).toBe("sk-fixture-new-key");
});
