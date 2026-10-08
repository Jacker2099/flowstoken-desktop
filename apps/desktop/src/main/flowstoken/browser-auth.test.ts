import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { app } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelSystemBrowserLogin, loginViaSystemBrowser } from "./browser-auth.js";
import type {
	acceptDesktopAuthorization,
	DesktopAuthorizationBundle,
	exchangeDesktopAuthorization,
} from "./newapi-client.js";

const boundary = vi.hoisted(() => ({
	revision: 1,
	listeners: new Set<() => void>(),
	open: vi.fn<(url: string) => Promise<void>>(),
	exchange: vi.fn<typeof exchangeDesktopAuthorization>(),
	commit: vi.fn<typeof acceptDesktopAuthorization>(),
	staging: {},
	dispose: vi.fn(async () => {}),
	window: { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() },
}));
const user = { id: 7, username: "fixture", displayName: "Fixture", quota: 0, usedQuota: 0, requestCount: 0 };
vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	return { app: new EventEmitter(), shell: { openExternal: boundary.open } };
});
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("../window-manager.js", () => ({
	showMainWindow: () => {
		boundary.window.restore();
		boundary.window.show();
		boundary.window.focus();
		return boundary.window;
	},
}));
vi.mock("./login-window.js", () => ({ getFlowstokenSession: () => ({}) }));
vi.mock("./auth-session.js", () => ({
	createDesktopAuthorizationSession: () => boundary.staging,
	disposeDesktopAuthorizationSession: boundary.dispose,
	importDesktopAuthorizationCookie: async (
		_staging: unknown,
		options: { assertCurrent: () => void; commit: () => unknown },
	) => {
		options.assertCurrent();
		return options.commit();
	},
}));
vi.mock("./newapi-client.js", () => ({
	FlowstokenApiError: class extends Error {},
	abortPendingFlowstokenRefresh: () => {},
	assertFlowstokenRequestAllowed: () => {},
	getFlowstokenAuthRevision: () => boundary.revision,
	onFlowstokenAuthChanged: (listener: () => void) => {
		boundary.listeners.add(listener);
		return () => boundary.listeners.delete(listener);
	},
	exchangeDesktopAuthorization: boundary.exchange,
	acceptDesktopAuthorization: boundary.commit,
}));

beforeEach(() => {
	vi.clearAllMocks();
	boundary.revision = 1;
	boundary.exchange.mockReset().mockResolvedValue({ accessToken: "fixture-access", sessionId: "fixture-sid", user });
	boundary.commit.mockReset().mockImplementation((bundle, _revision, signal: AbortSignal) => {
		signal.throwIfAborted();
		boundary.revision++;
		for (const listener of boundary.listeners) listener();
		return bundle.user;
	});
});
afterEach(async () => {
	cancelSystemBrowserLogin();
	await Promise.resolve();
	vi.useRealTimers();
	expect(boundary.listeners.size).toBe(0);
	expect(app.listenerCount("before-quit")).toBe(0);
	expect(boundary.dispose).toHaveBeenCalled();
});

async function start() {
	let opened!: (url: URL) => void;
	const url = new Promise<URL>((resolve) => {
		opened = resolve;
	});
	boundary.open.mockImplementation(async (value) => {
		opened(new URL(value));
	});
	const pending = loginViaSystemBrowser();
	void pending.catch(() => {});
	const authorize = await url;
	const callback = new URL(authorize.searchParams.get("redirect_uri")!);
	callback.searchParams.set("state", authorize.searchParams.get("state")!);
	callback.searchParams.set("code", "A".repeat(43));
	return { pending, authorize, callback };
}

it("opens the default browser with S256 PKCE, exchanges once, and focuses the existing app window", async () => {
	const flow = await start();
	expect(flow.authorize.origin + flow.authorize.pathname).toBe("https://www.flowstoken.com/auth/desktop");
	expect(flow.authorize.searchParams.get("client_id")).toBe("flowstoken-desktop");
	expect(flow.authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(flow.callback.hostname).toBe("127.0.0.1");
	expect(Number(flow.callback.port)).toBeGreaterThan(1023);
	expect(flow.authorize.searchParams.get("code_challenge_method")).toBe("S256");
	expect(loginViaSystemBrowser()).toBe(flow.pending);
	const response = await fetch(flow.callback);
	const body = await response.text();
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(body).not.toContain("fixture-access");
	expect(body).not.toContain("window.close");
	expect(body).not.toContain("A".repeat(43));
	expect(await flow.pending).toEqual(user);
	expect(boundary.open).toHaveBeenCalledTimes(1);
	expect(boundary.exchange).toHaveBeenCalledTimes(1);
	const payload = boundary.exchange.mock.calls[0][1] as { codeVerifier: string; redirectUri: string; code: string };
	expect(payload.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(createHash("sha256").update(payload.codeVerifier).digest("base64url")).toBe(
		flow.authorize.searchParams.get("code_challenge"),
	);
	expect(flow.authorize.toString()).not.toContain(payload.codeVerifier);
	expect(payload.redirectUri).toBe(flow.authorize.searchParams.get("redirect_uri"));
	await vi.waitFor(() => expect(boundary.window.focus).toHaveBeenCalledTimes(1));
});

it("rejects wrong Host, path, method, duplicate or Unicode state without consuming the valid flow", async () => {
	const flow = await start();
	const wrongHost = await new Promise<number>((resolve, reject) => {
		const request = httpRequest(flow.callback, { headers: { Host: "evil.invalid" } }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		request.on("error", reject);
		request.end();
	});
	expect(wrongHost).toBe(403);
	for (const change of ["path", "method", "state", "unicode", "duplicate"]) {
		const url = new URL(flow.callback);
		if (change === "path") url.pathname = "/not-the-callback";
		if (change === "state") url.searchParams.set("state", "B".repeat(43));
		if (change === "unicode") url.searchParams.set("state", "é".repeat(43));
		if (change === "duplicate") url.searchParams.append("state", url.searchParams.get("state")!);
		const response = await fetch(url, { method: change === "method" ? "POST" : "GET" });
		expect(response.status).toBe(403);
	}
	expect(boundary.exchange).not.toHaveBeenCalled();
	await fetch(flow.callback);
	await flow.pending;
});

it("rejects a replay while the original one-time code exchange is in flight", async () => {
	let release!: (value: DesktopAuthorizationBundle) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	boundary.exchange.mockImplementation(() => {
		entered();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const flow = await start();
	const first = fetch(flow.callback);
	await started;
	expect((await fetch(flow.callback)).status).toBe(409);
	release({ accessToken: "fixture-access", sessionId: "fixture-sid", user });
	await first;
	await flow.pending;
	expect(boundary.exchange).toHaveBeenCalledTimes(1);
});

it.each(["cancel", "quit", "account"])("aborts and discards a late exchange on %s", async (reason) => {
	let release!: (value: DesktopAuthorizationBundle) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	boundary.exchange.mockImplementation(() => {
		entered();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	const flow = await start();
	const callback = fetch(flow.callback).catch(() => undefined);
	await started;
	if (reason === "cancel") cancelSystemBrowserLogin();
	else if (reason === "quit") app.emit("before-quit", {});
	else {
		boundary.revision++;
		for (const listener of boundary.listeners) listener();
	}
	await expect(flow.pending).rejects.toThrow();
	expect((boundary.exchange.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(true);
	release({ accessToken: "late-fixture-access", sessionId: "fixture-sid", user });
	await callback;
	await Promise.resolve();
	expect(boundary.commit).not.toHaveBeenCalled();
});

it("expires after five minutes without polling or exchanging credentials", async () => {
	vi.useFakeTimers();
	const flow = await start();
	await vi.advanceTimersByTimeAsync(5 * 60_000);
	await expect(flow.pending).rejects.toThrow("loginTimedOut");
	expect(boundary.exchange).not.toHaveBeenCalled();
});

it("accepts an authenticated denial callback without issuing an exchange", async () => {
	const flow = await start();
	flow.callback.searchParams.delete("code");
	flow.callback.searchParams.set("error", "access_denied");
	expect((await fetch(flow.callback)).status).toBe(200);
	await expect(flow.pending).rejects.toThrow("loginCancelled");
	expect(boundary.exchange).not.toHaveBeenCalled();
});
