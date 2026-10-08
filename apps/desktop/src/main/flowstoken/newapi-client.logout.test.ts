import type { Cookie, CookiesSetDetails, Session } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFlowstokenSession, importDesktopAuthorizationCookie } from "./auth-session.js";
import {
	acceptDesktopAuthorization,
	clearCachedAccessToken,
	getCachedAccessToken,
	getFlowstokenAccountId,
	getFlowstokenAuthRevision,
	logoutFlowstokenAuthSession,
} from "./newapi-client.js";

const state = vi.hoisted(() => ({
	formal: undefined as unknown as Session,
	temporary: undefined as unknown as Session,
	fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
	clear: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({
	session: { fromPartition: (name: string) => (name.startsWith("persist:") ? state.formal : state.temporary) },
	net: { fetch: vi.fn() },
}));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
let stored: Cookie | undefined;
const refreshCookie = (value: string): Cookie => ({
	name: "new_api_refresh",
	value,
	domain: "www.flowstoken.com",
	hostOnly: true,
	path: "/api/user/auth",
	secure: true,
	httpOnly: true,
	sameSite: "strict",
	session: false,
	expirationDate: 9_999_999_999,
});
const user = (id: number) => ({
	id,
	username: "fixture",
	displayName: "Fixture",
	quota: 0,
	usedQuota: 0,
	requestCount: 0,
});

beforeEach(() => {
	clearCachedAccessToken();
	state.fetch.mockReset().mockResolvedValue(Response.json({ success: true }));
	state.clear.mockReset().mockImplementation(async () => {
		stored = undefined;
	});
	stored = refreshCookie("fixture-refresh-7");
	state.formal = {
		cookies: {
			get: async () => (stored ? [stored] : []),
			set: async (details: CookiesSetDetails) => {
				stored = refreshCookie(details.value ?? "");
			},
			remove: async () => {
				stored = undefined;
			},
		},
		clearStorageData: state.clear,
	} as unknown as Session;
	state.temporary = {
		fetch: state.fetch,
		closeAllConnections: async () => {},
		clearStorageData: async () => {},
	} as unknown as Session;
	getFlowstokenSession();
	acceptDesktopAuthorization(
		{ accessToken: "fixture-access-7", sessionId: "fixture-sid-7", user: user(7) },
		getFlowstokenAuthRevision(),
		new AbortController().signal,
	);
});
afterEach(() => {
	vi.useRealTimers();
	clearCachedAccessToken();
});

it("revokes only the captured app session and clears local state without an extra refresh", async () => {
	const first = logoutFlowstokenAuthSession(state.formal);
	expect(logoutFlowstokenAuthSession(state.formal)).toBe(first);
	expect(getCachedAccessToken()).toBeNull();
	await first;
	expect(state.fetch).toHaveBeenCalledOnce();
	const [url, init] = state.fetch.mock.calls[0];
	expect(url).toBe("https://www.flowstoken.com/api/user/auth/logout");
	const headers = new Headers(init.headers);
	expect(headers.get("X-Auth-Session")).toBe("fixture-sid-7");
	expect(headers.get("Authorization")).toBe("Bearer fixture-access-7");
	expect(headers.get("Cookie")).toBe("new_api_refresh=fixture-refresh-7");
	expect(init.redirect).toBe("error");
	expect(state.clear).toHaveBeenCalledOnce();
	expect(stored).toBeUndefined();
});

it.each(["offline", 403, 409, 429, 503])(
	"still signs out locally when remote revocation returns %s",
	async (failure) => {
		if (typeof failure === "string") state.fetch.mockRejectedValue(new TypeError("fetch failed"));
		else
			state.fetch.mockResolvedValue(
				new Response("unavailable", { status: failure, headers: { "Retry-After": "90" } }),
			);
		await logoutFlowstokenAuthSession(state.formal);
		expect(getFlowstokenAccountId()).toBeNull();
		expect(stored).toBeUndefined();
		expect(state.fetch).toHaveBeenCalledOnce();
	},
);

it("bounds remote logout and isolates its late response from the next successful login", async () => {
	vi.useFakeTimers();
	let release!: (response: Response) => void;
	state.fetch.mockImplementation(
		() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			}),
	);
	const pending = logoutFlowstokenAuthSession(state.formal);
	await vi.advanceTimersByTimeAsync(5_000);
	await pending;
	expect(stored).toBeUndefined();
	expect((state.fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
	const revision = getFlowstokenAuthRevision();
	await importDesktopAuthorizationCookie(
		{ cookies: { get: async () => [refreshCookie("fixture-refresh-8")] } } as unknown as Session,
		{
			assertCurrent: () => {
				expect(getFlowstokenAuthRevision()).toBe(revision);
			},
			shouldRestorePrevious: () => true,
			commit: () =>
				acceptDesktopAuthorization(
					{ accessToken: "fixture-access-8", sessionId: "fixture-sid-8", user: user(8) },
					revision,
					new AbortController().signal,
				),
		},
	);
	release(
		new Response(null, {
			status: 204,
			headers: { "Set-Cookie": "new_api_refresh=; Path=/api/user/auth; Max-Age=0" },
		}),
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(stored?.value).toBe("fixture-refresh-8");
	expect(getFlowstokenAccountId()).toBe(8);
	expect(state.clear).toHaveBeenCalledOnce();
});
