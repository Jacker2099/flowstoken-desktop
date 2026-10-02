import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLOWSTOKEN_API_ORIGIN, FLOWSTOKEN_GROUPS } from "./constants.js";
import {
	clearCachedAccessToken,
	createToken,
	fetchSelf,
	fetchUsableGroups,
	findManagedToken,
	getCachedAccessToken,
	listTokens,
	managedTokenName,
	refreshAuth,
	setCachedAccessToken,
} from "./newapi-client.js";

vi.mock("electron", () => ({
	net: {
		fetch: vi.fn(() => {
			throw new Error("unexpected network request");
		}),
	},
}));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));

beforeEach(() => clearCachedAccessToken());

describe("FlowsToken cookie scope", () => {
	it("bounds an incomplete metadata body and never installs a late access token", async () => {
		vi.useFakeTimers();
		try {
			let body!: ReadableStreamDefaultController<Uint8Array>;
			let signal: AbortSignal | null | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					body = controller;
				},
			});
			const session = {
				cookies: { get: async () => [] },
				fetch: async (_url: string, init: RequestInit) => {
					signal = init.signal;
					return new Response(stream);
				},
			} as unknown as Session;
			const request = refreshAuth(session).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(await request).toBeInstanceOf(Error);
			expect(signal?.aborted).toBe(true);
			body.enqueue(
				new TextEncoder().encode(
					JSON.stringify({ success: true, data: { access_token: "fixture-late-token", user: { id: 7 } } }),
				),
			);
			body.close();
			await vi.runAllTimersAsync();
			expect(getCachedAccessToken()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not send the old account's token creation after logout during cookie loading", async () => {
		let finish!: (cookies: unknown[]) => void;
		let started!: () => void;
		const cookiesStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const cookies = new Promise<unknown[]>((resolve) => {
			finish = resolve;
		});
		const fetch = vi.fn(async () => Response.json({ success: true, data: {} }));
		const session = {
			cookies: {
				get: () => {
					started();
					return cookies;
				},
			},
			fetch,
		} as unknown as Session;
		setCachedAccessToken("fixture-old-account");
		const creating = createToken(session, { name: "fixture", group: "default" }).catch((error: unknown) => error);
		await cookiesStarted;
		clearCachedAccessToken();
		finish([]);
		expect(await creating).toBeInstanceOf(Error);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("shares concurrent refreshes so rotated refresh cookies produce one current access token", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				success: true,
				data: { access_token: "fixture-access", user: { id: 7, username: "fixture" } },
			}),
		);
		const session = { cookies: { get: async () => [] }, fetch } as unknown as Session;
		const results = await Promise.all([refreshAuth(session), refreshAuth(session)]);
		expect(results.map((r) => r.accessToken)).toEqual(["fixture-access", "fixture-access"]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"does not revive the previous account when a delayed refresh completes after logout or a new login: %s",
		async (newLogin) => {
			let finish!: (response: Response) => void;
			const pending = new Promise<Response>((resolve) => {
				finish = resolve;
			});
			const session = { cookies: { get: async () => [] }, fetch: () => pending } as unknown as Session;
			const old = refreshAuth(session).catch((error: unknown) => error);
			clearCachedAccessToken();
			if (newLogin) setCachedAccessToken("fixture-new-account");
			finish(Response.json({ success: true, data: { access_token: "fixture-old-account", user: { id: 7 } } }));
			expect(await old).toBeInstanceOf(Error);
			expect(getCachedAccessToken()).toBe(newLogin ? "fixture-new-account" : null);
		},
	);

	it("refuses a late account response after logout without starting another authenticated request", async () => {
		let finish!: (response: Response) => void;
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const response = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const fetch = vi.fn(() => {
			started();
			return response;
		});
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
		const fallbackStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const response = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const session = {
			cookies: { get: async () => [] },
			fetch: (url: string) => {
				if (url.endsWith("/auth/refresh")) return Promise.reject(new Error("offline"));
				started();
				return response;
			},
		} as unknown as Session;
		setCachedAccessToken("fixture-old-account");
		const probe = fetchSelf(session).catch((error: unknown) => error);
		await fallbackStarted;
		setCachedAccessToken("fixture-new-account");
		finish(Response.json({ success: true, data: { id: 7, username: "old-account" } }));
		expect(await probe).toBeInstanceOf(Error);
		expect(getCachedAccessToken()).toBe("fixture-new-account");
	});

	it("rejects a successful refresh envelope without a valid account identity", async () => {
		const session = {
			cookies: { get: async () => [] },
			fetch: async () =>
				Response.json({
					success: true,
					data: { access_token: "fixture-access", user: { username: "fixture" } },
				}),
		} as unknown as Session;
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
	it("finds a managed key beyond the first token page instead of creating a duplicate", async () => {
		const pages: number[] = [];
		const session = {
			cookies: { get: async () => [] },
			fetch: async (url: string) => {
				const page = Number(new URL(url).searchParams.get("p"));
				pages.push(page);
				const items =
					page === 1
						? Array.from({ length: 100 }, (_, index) => ({
								id: index + 1,
								name: `fixture-${index}`,
								group: "default",
								status: 1,
							}))
						: [{ id: 101, name: FLOWSTOKEN_GROUPS[0].tokenName, group: "default", status: 1 }];
				return Response.json({ success: true, data: { total: 101, items } });
			},
		} as unknown as Session;
		setCachedAccessToken("fixture-access");
		expect(findManagedToken(await listTokens(session), "default")?.id).toBe(101);
		expect(pages).toEqual([1, 2]);
	});

	it("uses the authenticated available groups and preserves billing identifiers exactly", async () => {
		const requests: Array<{ path: string; authorization: string | null }> = [];
		const session = {
			cookies: { get: async () => [] },
			fetch: async (url: string, init: RequestInit) => {
				requests.push({
					path: new URL(url).pathname,
					authorization: new Headers(init.headers).get("Authorization"),
				});
				return Response.json({ success: true, data: { default: { ratio: 1 }, "Research-X": { ratio: 1.5 } } });
			},
		} as unknown as Session;
		setCachedAccessToken("fixture-account");
		expect([...(await fetchUsableGroups(session))]).toEqual(["default", "Research-X"]);
		expect(requests).toEqual([{ path: "/api/user/self/groups", authorization: "Bearer fixture-account" }]);
	});

	it("does not turn a malformed entitlement response into permission for public catalog groups", async () => {
		const session = {
			cookies: { get: async () => [] },
			fetch: async () => Response.json({ success: true, data: ["vip"] }),
		} as unknown as Session;
		setCachedAccessToken("fixture-account");
		await expect(fetchUsableGroups(session)).rejects.toThrow("entitlementsUnavailable");
	});

	it("keeps new managed names stable within the server limit and verifies the actual token group", () => {
		const groupId = `Research-${"X".repeat(55)}`;
		const name = managedTokenName(groupId);
		expect(Buffer.byteLength(name)).toBeLessThanOrEqual(50);
		expect(managedTokenName(groupId)).toBe(name);
		const correct = { id: 8, name, group: groupId, status: 1 };
		expect(
			findManagedToken(
				[
					{ ...correct, id: 1, group: "vip" },
					{ ...correct, id: 2, status: 2 },
					{ ...correct, id: 3, name: "FlowsToken-Desktop-user-created" },
					correct,
				],
				groupId,
			),
		).toBe(correct);
		for (const legacy of FLOWSTOKEN_GROUPS) expect(managedTokenName(legacy.id)).toBe(legacy.tokenName);
	});

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
