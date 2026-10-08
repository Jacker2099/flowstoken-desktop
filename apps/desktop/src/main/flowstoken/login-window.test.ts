import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLOWSTOKEN_SITE_URL } from "./constants.js";
import * as login from "./login-window.js";
import { clearCachedAccessToken, getCachedAccessToken, refreshAuth } from "./newapi-client.js";

const boundary = vi.hoisted(() => {
	const fetch = vi.fn();
	return {
		fetch,
		windows: [] as BrowserWindow[],
		session: {
			fetch,
			cookies: { get: vi.fn(async () => []), flushStore: vi.fn(async () => {}) },
			clearStorageData: vi.fn(async () => {}),
		},
	};
});

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	class Window extends EventEmitter {
		private destroyed = false;
		private url = "";
		private contents = Object.assign(new EventEmitter(), {
			getURL: () => this.url,
			isDestroyed: () => this.destroyed,
			executeJavaScript: vi.fn(async () => null),
		});
		get webContents() {
			if (this.destroyed) throw new Error("Object has been destroyed");
			return this.contents;
		}
		constructor() {
			super();
			boundary.windows.push(this as unknown as BrowserWindow);
		}
		isDestroyed() {
			return this.destroyed;
		}
		getTitle() {
			return "";
		}
		async loadURL(url: string) {
			this.url = url;
			this.webContents.emit("did-navigate");
		}
		close() {
			if (this.destroyed) return;
			this.destroyed = true;
			this.emit("closed");
		}
	}
	return { BrowserWindow: Window, session: { fromPartition: () => boundary.session }, net: { fetch: boundary.fetch } };
});
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));

beforeEach(() => {
	vi.useFakeTimers();
	clearCachedAccessToken();
	boundary.fetch.mockReset();
	boundary.session = {
		fetch: boundary.fetch,
		cookies: { get: vi.fn(async () => []), flushStore: vi.fn(async () => {}) },
		clearStorageData: vi.fn(async () => {}),
	};
	boundary.windows = [];
	boundary.fetch.mockImplementation(async () =>
		Response.json({ success: true, data: { access_token: "fixture-access", user: { id: 7, username: "fixture" } } }),
	);
});
afterEach(async () => {
	for (const window of boundary.windows) window.close();
	await vi.runAllTimersAsync();
	vi.useRealTimers();
});

describe("browser login request ownership", () => {
	it("does not probe unauthenticated login pages while the user is still completing login", async () => {
		const pending = login.loginViaBrowserWindow().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(boundary.fetch).not.toHaveBeenCalled();
		boundary.windows[0].close();
		await expect(pending).resolves.toBeInstanceOf(Error);
	});

	it("shares the login window and honors Retry-After without in-page refresh requests", async () => {
		boundary.fetch.mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "Retry-After": "120" } }));
		const pending = login.loginViaBrowserWindow().catch((error: unknown) => error);
		const duplicate = login.loginViaBrowserWindow().catch((error: unknown) => error);
		expect(boundary.windows).toHaveLength(1);
		const window = boundary.windows[0];
		await window.loadURL(`${FLOWSTOKEN_SITE_URL}/console`);
		await vi.advanceTimersByTimeAsync(0);
		expect(boundary.fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(119_000);
		expect(boundary.fetch).toHaveBeenCalledTimes(1);
		expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toMatchObject({ id: 7 });
		await expect(duplicate).resolves.toMatchObject({ id: 7 });
		expect(boundary.fetch).toHaveBeenCalledTimes(2);
		expect(window.isDestroyed()).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("closing the window cancels its pending probe and a late reply cannot install the account", async () => {
		let finish!: (response: Response) => void;
		let signal: AbortSignal | undefined;
		boundary.fetch.mockImplementation((_url: string, init: RequestInit) => {
			signal = init.signal ?? undefined;
			return new Promise<Response>((resolve) => {
				finish = resolve;
			});
		});
		const pending = login.loginViaBrowserWindow().catch((error: unknown) => error);
		await boundary.windows[0].loadURL(`${FLOWSTOKEN_SITE_URL}/console`);
		await vi.advanceTimersByTimeAsync(0);
		boundary.windows[0].close();
		await expect(pending).resolves.toMatchObject({ message: "flowstoken.errors.loginCancelled" });
		expect(signal?.aborted).toBe(true);
		finish(Response.json({ success: true, data: { access_token: "late", user: { id: 7 } } }));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(getCachedAccessToken()).toBeNull();
		expect(boundary.fetch).toHaveBeenCalledTimes(1);
		expect(boundary.session.clearStorageData).not.toHaveBeenCalled();
	});

	it("bounds an abandoned login window without issuing repeated unauthenticated probes", async () => {
		let outcome: unknown;
		const pending = login.loginViaBrowserWindow().catch((error: unknown) => {
			outcome = error;
		});
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(outcome).toMatchObject({ message: "flowstoken.errors.loginTimedOut" });
		await pending;
		expect(boundary.windows[0].isDestroyed()).toBe(true);
		expect(boundary.fetch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("navigation events cannot bypass backoff after an unavailable session service", async () => {
		boundary.fetch.mockImplementation(async () => Response.json({ success: false }, { status: 503 }));
		const pending = login.loginViaBrowserWindow().catch((error: unknown) => error);
		const window = boundary.windows[0];
		await window.loadURL(`${FLOWSTOKEN_SITE_URL}/console`);
		await vi.advanceTimersByTimeAsync(0);
		for (let index = 0; index < 100; index++) window.webContents.emit("did-navigate-in-page");
		await vi.advanceTimersByTimeAsync(2_999);
		expect(boundary.fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(27_001);
		expect(boundary.fetch.mock.calls.length).toBeLessThanOrEqual(5);
		window.close();
		await pending;
	});

	it("an active cooldown rejects a new login before opening another browser or security challenge", async () => {
		boundary.fetch.mockResolvedValueOnce(
			new Response("limited", { status: 429, headers: { "Retry-After": "1113" } }),
		);
		await expect(refreshAuth(login.getFlowstokenSession())).rejects.toMatchObject({ status: 429 });
		await expect(login.loginViaBrowserWindow()).rejects.toMatchObject({ status: 429, retryAfterMs: 1_113_000 });
		await expect(login.loginWithPasswordAndTurnstile("fixture", "fixture")).rejects.toMatchObject({ status: 429 });
		expect(boundary.windows).toHaveLength(0);
		expect(boundary.fetch).toHaveBeenCalledTimes(1);
	});

	it("an abandoned password security challenge times out without submitting credentials", async () => {
		const pending = login.loginWithPasswordAndTurnstile("fixture", "fixture").catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await expect(pending).resolves.toMatchObject({ message: "flowstoken.errors.loginTimedOut" });
		expect(boundary.fetch).not.toHaveBeenCalled();
		expect(boundary.windows[0].isDestroyed()).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("explicit logout closes a pending browser login and stops its probes before clearing cookies", async () => {
		const pending = login.loginViaBrowserWindow().catch((error: unknown) => error);
		await login.clearFlowstokenSession();
		expect(boundary.windows[0].isDestroyed()).toBe(true);
		await expect(pending).resolves.toMatchObject({ message: "flowstoken.errors.loginCancelled" });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(boundary.fetch).not.toHaveBeenCalled();
		expect(boundary.session.clearStorageData).toHaveBeenCalledWith({ storages: ["cookies", "localstorage"] });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("account snapshot probes", () => {
	it.each([429, 503])(
		"a transient HTTP %s probe retains a previously verified user without clearing cookies",
		async (status) => {
			await refreshAuth(login.getFlowstokenSession());
			boundary.fetch.mockImplementation(async () => Response.json({ success: false }, { status }));
			await expect(login.probeExistingSession()).resolves.toMatchObject({ id: 7 });
			expect(login.getFlowstokenSessionProbeError()).toBeTruthy();
			expect(getCachedAccessToken()).toBe("fixture-access");
			expect(boundary.session.clearStorageData).not.toHaveBeenCalled();
		},
	);

	it("a genuine 401 produces logged-out state, while an initial 503 stays an error", async () => {
		await refreshAuth(login.getFlowstokenSession());
		boundary.fetch.mockResolvedValueOnce(Response.json({ success: false }, { status: 401 }));
		await expect(login.probeExistingSession()).resolves.toBeNull();
		expect(getCachedAccessToken()).toBeNull();
		boundary.fetch.mockResolvedValueOnce(Response.json({ success: false }, { status: 503 }));
		await expect(login.probeExistingSession()).rejects.toMatchObject({ status: 503 });
	});
});
