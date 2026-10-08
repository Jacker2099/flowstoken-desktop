import type { Session } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import {
	acceptDesktopAuthorization,
	assertFlowstokenRequestAllowed,
	clearCachedAccessToken,
	exchangeDesktopAuthorization,
	fetchSelf,
	getCachedAccessToken,
	getFlowstokenAccountId,
	getFlowstokenAuthRevision,
	refreshAuth,
} from "./newapi-client.js";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
beforeEach(() => clearCachedAccessToken());
const input = {
	code: "A".repeat(43),
	codeVerifier: "B".repeat(43),
	redirectUri: "http://127.0.0.1:43121/flowstoken/callback",
};
const response = () =>
	Response.json({
		success: true,
		data: {
			access_token: "fixture-access",
			session: { sid: "fixture-session-id" },
			user: { id: 7, username: "fixture" },
		},
	});
function fixture(send: (url: string, init: RequestInit) => Promise<Response> = async () => response()) {
	const fetch = vi.fn(send);
	const session = { cookies: { get: vi.fn(async () => []) }, fetch } as unknown as Session;
	return { session, fetch };
}

it("exchanges only an authorization code over HTTPS and commits the verified account atomically", async () => {
	const { session, fetch } = fixture();
	const controller = new AbortController();
	const revision = getFlowstokenAuthRevision();
	const bundle = await exchangeDesktopAuthorization(session, input, { signal: controller.signal, revision });
	expect(getCachedAccessToken()).toBeNull();
	const [url, init] = fetch.mock.calls[0];
	expect(url).toBe("https://www.flowstoken.com/api/user/auth/desktop/exchange");
	expect(new Headers(init.headers).get("Origin")).toBe("https://www.flowstoken.com");
	expect(JSON.parse(String(init.body))).toEqual({
		client_id: "flowstoken-desktop",
		code: input.code,
		code_verifier: input.codeVerifier,
		redirect_uri: input.redirectUri,
	});
	expect(acceptDesktopAuthorization(bundle, revision, controller.signal).id).toBe(7);
	expect(getCachedAccessToken()).toBe("fixture-access");
	expect(getFlowstokenAccountId()).toBe(7);
	expect(getFlowstokenAuthRevision()).toBe(revision + 1);
	await refreshAuth(session);
	expect(new Headers(fetch.mock.calls[1][1].headers).get("X-Auth-Session")).toBe("fixture-session-id");
});

it("retains the expected SID after a mismatched refresh and never falls back to the wrong cookie", async () => {
	const { session, fetch } = fixture();
	const controller = new AbortController();
	const revision = getFlowstokenAuthRevision();
	acceptDesktopAuthorization(
		await exchangeDesktopAuthorization(session, input, { signal: controller.signal, revision }),
		revision,
		controller.signal,
	);
	fetch.mockImplementation(async () =>
		Response.json({ success: false, code: "AUTH_SESSION_MISMATCH", message: "Conflict" }, { status: 409 }),
	);
	await expect(fetchSelf(session)).rejects.toMatchObject({ status: 409 });
	await expect(fetchSelf(session)).rejects.toMatchObject({ status: 409 });
	expect(getFlowstokenAccountId()).toBe(7);
	for (const [_url, init] of fetch.mock.calls.slice(1))
		expect(new Headers(init.headers).get("X-Auth-Session")).toBe("fixture-session-id");
	expect(fetch.mock.calls.slice(1).every(([url]) => url.endsWith("/api/user/auth/refresh"))).toBe(true);
});

it.each(["abort", "account"])("does not commit an exchange returned after %s invalidation", async (reason) => {
	let release!: (value: Response) => void;
	let started!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const fetch = vi.fn((_url: string, _init: RequestInit) => {
		started();
		return new Promise<Response>((resolve) => {
			release = resolve;
		});
	});
	const { session } = fixture(fetch);
	const controller = new AbortController();
	const revision = getFlowstokenAuthRevision();
	const pending = exchangeDesktopAuthorization(session, input, { signal: controller.signal, revision });
	void pending.catch(() => {});
	await entered;
	if (reason === "abort") controller.abort(new Error("fixture canceled"));
	else clearCachedAccessToken();
	release(response());
	await expect(pending).rejects.toThrow();
	expect(getCachedAccessToken()).toBeNull();
	expect(getFlowstokenAccountId()).toBeNull();
});

it("blocks a verified bundle if authorization is canceled before committing", async () => {
	const { session } = fixture();
	const controller = new AbortController();
	const revision = getFlowstokenAuthRevision();
	const bundle = await exchangeDesktopAuthorization(session, input, { signal: controller.signal, revision });
	controller.abort(new Error("fixture canceled"));
	expect(() => acceptDesktopAuthorization(bundle, revision, controller.signal)).toThrow("fixture canceled");
	expect(getCachedAccessToken()).toBeNull();
});

it("honors an exchange Retry-After before another authorization request", async () => {
	const { session, fetch } = fixture(
		vi.fn(async () => new Response("limited", { status: 429, headers: { "Retry-After": "90" } })),
	);
	const options = { signal: new AbortController().signal, revision: getFlowstokenAuthRevision() };
	await expect(exchangeDesktopAuthorization(session, input, options)).rejects.toMatchObject({ status: 429 });
	await expect(exchangeDesktopAuthorization(session, input, options)).rejects.toMatchObject({ status: 429 });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(getCachedAccessToken()).toBeNull();
});

it("keeps a staged exchange rate limit on the formal session when a new staging session is created", async () => {
	const first = fixture(async () => new Response("limited", { status: 429, headers: { "Retry-After": "90" } }));
	const formal = fixture();
	const options = {
		signal: new AbortController().signal,
		revision: getFlowstokenAuthRevision(),
		rateLimitSession: formal.session,
	};
	await expect(exchangeDesktopAuthorization(first.session, input, options)).rejects.toMatchObject({ status: 429 });
	expect(() => assertFlowstokenRequestAllowed(formal.session)).toThrow();
	const second = fixture();
	await expect(exchangeDesktopAuthorization(second.session, input, options)).rejects.toMatchObject({ status: 429 });
	expect(second.fetch).not.toHaveBeenCalled();
});

it("does not change auth generation when an already signed-out background refresh returns 401", async () => {
	const { session } = fixture(async () => Response.json({ success: false }, { status: 401 }));
	const revision = getFlowstokenAuthRevision();
	await expect(refreshAuth(session)).rejects.toMatchObject({ status: 401 });
	expect(getFlowstokenAuthRevision()).toBe(revision);
	expect(getCachedAccessToken()).toBeNull();
});

it.each([{ access_token: "fixture-access" }, { user: { id: 7 } }, { access_token: "fixture-access", user: { id: 0 } }])(
	"rejects malformed exchange bundles: %j",
	async (data) => {
		const { session } = fixture(vi.fn(async () => Response.json({ success: true, data })));
		await expect(
			exchangeDesktopAuthorization(session, input, {
				signal: new AbortController().signal,
				revision: getFlowstokenAuthRevision(),
			}),
		).rejects.toThrow();
		expect(getCachedAccessToken()).toBeNull();
	},
);
