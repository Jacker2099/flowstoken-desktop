import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLOWSTOKEN_API_ORIGIN, FLOWSTOKEN_GROUPS } from "./constants.js";
import { clearCachedAccessToken, fetchSelf, findManagedToken, getCachedAccessToken, listTokens, refreshAuth, setCachedAccessToken } from "./newapi-client.js";

vi.mock("electron", () => ({
	net: {
		fetch: vi.fn(() => {
			throw new Error("unexpected network request");
		}),
	},
}));

beforeEach(() => clearCachedAccessToken());

describe("FlowsToken cookie scope", () => {
	it("shares concurrent refreshes so rotated refresh cookies produce one current access token", async () => {
		const fetch = vi.fn(async () => Response.json({
			success: true, data: { access_token: "fixture-access", user: { id: 7, username: "fixture" } },
		}));
		const session = { cookies: { get: async () => [] }, fetch } as unknown as Session;
		const results = await Promise.all([refreshAuth(session), refreshAuth(session)]);
		expect(results.map((r) => r.accessToken)).toEqual(["fixture-access", "fixture-access"]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("does not revive the previous account when a delayed refresh completes after logout or a new login: %s", async (newLogin) => {
		let finish!: (response: Response) => void;
		const pending = new Promise<Response>((resolve) => { finish = resolve; });
		const session = { cookies: { get: async () => [] }, fetch: () => pending } as unknown as Session;
		const old = refreshAuth(session).catch((error: unknown) => error);
		clearCachedAccessToken();
		if (newLogin) setCachedAccessToken("fixture-new-account");
		finish(Response.json({ success: true, data: { access_token: "fixture-old-account", user: { id: 7 } } }));
		expect(await old).toBeInstanceOf(Error);
		expect(getCachedAccessToken()).toBe(newLogin ? "fixture-new-account" : null);
	});

	it("refuses a late account response after logout without starting another authenticated request", async () => {
		let finish!: (response: Response) => void;
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => { started = resolve; });
		const response = new Promise<Response>((resolve) => { finish = resolve; });
		const fetch = vi.fn(() => { started(); return response; });
		const session = { cookies: { get: async () => [] }, fetch } as unknown as Session;
		setCachedAccessToken("fixture-old-account");
		const listing = listTokens(session).catch((error: unknown) => error);
		await requestStarted;
		clearCachedAccessToken();
		finish(Response.json({ success: true, data: { items: [{ id: 1, name: "old-account-token" }] } }));
		expect(await listing).toBeInstanceOf(Error);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(getCachedAccessToken()).toBeNull();
	});

	it("does not clear a new login or restore the old user when an offline bearer fallback finishes late", async () => {
		let finish!: (response: Response) => void;
		let started!: () => void;
		const fallbackStarted = new Promise<void>((resolve) => { started = resolve; });
		const response = new Promise<Response>((resolve) => { finish = resolve; });
		const session = { cookies: { get: async () => [] }, fetch: (url: string) => {
			if (url.endsWith("/auth/refresh")) return Promise.reject(new Error("offline"));
			started();
			return response;
		} } as unknown as Session;
		setCachedAccessToken("fixture-old-account");
		const probe = fetchSelf(session).catch((error: unknown) => error);
		await fallbackStarted;
		setCachedAccessToken("fixture-new-account");
		finish(Response.json({ success: true, data: { id: 7, username: "old-account" } }));
		expect(await probe).toBeInstanceOf(Error);
		expect(getCachedAccessToken()).toBe("fixture-new-account");
	});

	it("rejects a successful refresh envelope without a valid account identity", async () => {
		const session = { cookies: { get: async () => [] }, fetch: async () => Response.json({
			success: true, data: { access_token: "fixture-access", user: { username: "fixture" } },
		}) } as unknown as Session;
		await expect(refreshAuth(session)).rejects.toThrow();
		expect(getCachedAccessToken()).toBeNull();
	});

	it("refreshes with the matching refresh cookie but does not send it or OAuth cookies to token endpoints", async () => {
		const refreshUrl = `${FLOWSTOKEN_API_ORIGIN}/api/user/auth/refresh`;
		const requests: Array<{ url: string; headers: Headers }> = [];
		const cookies = {
			get: vi.fn(async (filter: { url?: string }) =>
				filter.url === refreshUrl
					? [{ name: "new_api_refresh", value: "fixture-refresh" }]
					: filter.url
						? []
						: [
								{ name: "new_api_refresh", value: "fixture-refresh" },
								{ name: "oauth_session", value: "fixture-third-party" },
							],
			),
		};
		const session = {
			cookies,
			fetch: async (url: string, init: RequestInit) => {
				requests.push({ url, headers: new Headers(init.headers) });
				return Response.json({
					success: true,
					data:
						url === refreshUrl
							? { access_token: "fixture-access", user: { id: 7, username: "fixture" } }
							: { items: [] },
				});
			},
		} as unknown as Session;

		await refreshAuth(session);
		await listTokens(session);

		expect(requests[0].headers.get("Cookie")).toBe("new_api_refresh=fixture-refresh");
		expect(requests[1].headers.get("Authorization")).toBe("Bearer fixture-access");
		expect(requests[1].headers.has("Cookie")).toBe(false);
		expect(cookies.get.mock.calls.every(([filter]) => Boolean(filter.url))).toBe(true);
	});
});

describe("FlowsToken managed token selection", () => {
	const group = FLOWSTOKEN_GROUPS[0];
	it.each([
		{ group: "vip", status: 1 },
		{ group: "default", status: 2 },
		{ group: "default", status: 3 },
		{ group: "default", status: 4 },
		{ group: "default", status: undefined },
	])("rejects the same name with unusable metadata %j", (metadata) => {
		expect(findManagedToken([{ id: 1, name: group.tokenName, ...metadata }], group.id)).toBeUndefined();
	});
	it("prefers an enabled exact-name token in the correct group and supports older managed names", () => {
		const legacy = { id: 1, name: "FlowsToken-Desktop-old", group: "default", status: 1 };
		const current = { id: 2, name: group.tokenName, group: "default", status: 1 };
		expect(findManagedToken([legacy, current], group.id)).toBe(current);
		expect(findManagedToken([legacy], group.id)).toBe(legacy);
	});
});
