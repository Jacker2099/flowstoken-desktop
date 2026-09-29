import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLOWSTOKEN_API_ORIGIN, FLOWSTOKEN_GROUPS } from "./constants.js";
import { clearCachedAccessToken, findManagedToken, listTokens, refreshAuth } from "./newapi-client.js";

vi.mock("electron", () => ({
	net: {
		fetch: vi.fn(() => {
			throw new Error("unexpected network request");
		}),
	},
}));

beforeEach(() => clearCachedAccessToken());

describe("FlowsToken cookie scope", () => {
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
