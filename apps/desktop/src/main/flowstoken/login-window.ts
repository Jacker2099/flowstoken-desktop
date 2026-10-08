import { BrowserWindow } from "electron";
import { mainT } from "../i18n/index.js";
import { getFlowstokenSession } from "./auth-session.js";
import { FLOWSTOKEN_SITE_URL } from "./constants.js";
import {
	assertFlowstokenRequestAllowed,
	FlowstokenApiError,
	fetchSelf,
	getCachedFlowstokenUser,
	getFlowstokenAuthRevision,
	getFlowstokenRequestCooldownMs,
	loginWithPassword,
	logoutFlowstokenAuthSession,
	refreshAuth,
} from "./newapi-client.js";
import type { FlowstokenUserSnapshot } from "./types.js";

export { getFlowstokenSession } from "./auth-session.js";

const pendingLoginCancels = new Set<() => void>();

export async function clearFlowstokenSession(): Promise<void> {
	for (const cancel of pendingLoginCancels) cancel();
	await logoutFlowstokenAuthSession(getFlowstokenSession());
}

let sessionProbeError: string | undefined;

export function getFlowstokenSessionProbeError(): string | undefined {
	return sessionProbeError;
}

export async function probeExistingSession(): Promise<FlowstokenUserSnapshot | null> {
	const revision = getFlowstokenAuthRevision();
	try {
		const user = await fetchSelf(getFlowstokenSession());
		sessionProbeError = undefined;
		return user;
	} catch (error) {
		if (error instanceof FlowstokenApiError && error.status === 401) {
			sessionProbeError = undefined;
			return null;
		}
		if (revision !== getFlowstokenAuthRevision()) throw error;
		sessionProbeError = error instanceof Error ? error.message : mainT("flowstoken.errors.requestUnavailable");
		const user = getCachedFlowstokenUser();
		if (user) return user;
		throw error;
	}
}

function looksLikeLoggedInUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (!/(^|\.)flowstoken\.com$/i.test(u.hostname)) return false;
		const path = u.pathname.toLowerCase();
		if (path.startsWith("/login") || path.startsWith("/register") || path.startsWith("/reset")) {
			return false;
		}
		return (
			path.startsWith("/console") ||
			path.startsWith("/dashboard") ||
			path.startsWith("/panel") ||
			path.startsWith("/token") ||
			path.startsWith("/topup") ||
			path.startsWith("/wallet") ||
			path.startsWith("/user") ||
			path === "/"
		);
	} catch {
		return false;
	}
}

let browserLogin: Promise<FlowstokenUserSnapshot> | null = null;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_PROBE_INTERVAL_MS = 3_000;

export function loginViaBrowserWindow(): Promise<FlowstokenUserSnapshot> {
	if (browserLogin) return browserLogin;
	try {
		assertFlowstokenRequestAllowed(getFlowstokenSession());
	} catch (error) {
		return Promise.reject(error);
	}
	const promise = openLoginWindow().finally(() => {
		if (browserLogin === promise) browserLogin = null;
	});
	browserLogin = promise;
	return promise;
}

function openLoginWindow(): Promise<FlowstokenUserSnapshot> {
	return new Promise((resolve, reject) => {
		const ses = getFlowstokenSession();
		const win = new BrowserWindow({
			width: 480,
			height: 740,
			title: "登录 FlowsToken",
			autoHideMenuBar: true,
			webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
		});
		const controller = new AbortController();
		const deadline = Date.now() + LOGIN_TIMEOUT_MS;
		let settled = false;
		let probeInFlight = false;
		let failures = 0;
		let notBefore = 0;
		let poll: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: { user: FlowstokenUserSnapshot } | { error: Error }) => {
			if (settled) return;
			settled = true;
			pendingLoginCancels.delete(cancel);
			if (poll !== undefined) clearTimeout(poll);
			clearTimeout(timeout);
			if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
				win.webContents.removeListener("did-navigate", onNavigate);
				win.webContents.removeListener("did-navigate-in-page", onNavigate);
				win.webContents.removeListener("did-finish-load", onNavigate);
			}
			if ("error" in result) {
				controller.abort(result.error);
				reject(result.error);
			} else {
				resolve(result.user);
			}
			void ses.cookies.flushStore().catch(() => {});
			if (!win.isDestroyed()) win.close();
		};
		const cancel = () => finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.loginCancelled")) });

		const schedule = (delay: number) => {
			if (settled) return;
			if (poll !== undefined) clearTimeout(poll);
			poll = setTimeout(() => {
				void tryProbe();
			}, delay);
		};

		const tryProbe = async () => {
			if (settled || probeInFlight || win.isDestroyed()) return;
			const wait = Math.max(notBefore - Date.now(), getFlowstokenRequestCooldownMs(ses));
			if (wait > 0) {
				schedule(wait);
				return;
			}
			// The login page owns interactive sign-in. Only verify after it navigates to an authenticated route.
			// All refreshes use the same session client, so in-page polling cannot bypass its cooldown or coalescing.
			if (!looksLikeLoggedInUrl(win.webContents.getURL())) {
				schedule(LOGIN_PROBE_INTERVAL_MS);
				return;
			}
			probeInFlight = true;
			try {
				const { user } = await refreshAuth(ses, { signal: controller.signal });
				finish({ user });
			} catch (error) {
				if (settled) return;
				failures++;
				const retryAfterMs = error instanceof FlowstokenApiError ? (error.retryAfterMs ?? 0) : 0;
				if (retryAfterMs >= deadline - Date.now()) {
					finish({
						error: error instanceof Error ? error : new Error(mainT("flowstoken.errors.requestUnavailable")),
					});
					return;
				}
				notBefore =
					Date.now() +
					Math.max(retryAfterMs, Math.min(30_000, LOGIN_PROBE_INTERVAL_MS * 2 ** Math.min(failures - 1, 4)));
			} finally {
				probeInFlight = false;
				if (!settled) schedule(Math.max(LOGIN_PROBE_INTERVAL_MS, notBefore - Date.now()));
			}
		};

		const onNavigate = () => {
			if (!settled && !win.isDestroyed() && looksLikeLoggedInUrl(win.webContents.getURL())) void tryProbe();
		};
		const timeout = setTimeout(() => {
			finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.loginTimedOut")) });
		}, LOGIN_TIMEOUT_MS);
		win.webContents.on("did-navigate", onNavigate);
		win.webContents.on("did-navigate-in-page", onNavigate);
		win.webContents.on("did-finish-load", onNavigate);
		win.on("closed", () => finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.loginCancelled")) }));
		pendingLoginCancels.add(cancel);
		schedule(LOGIN_PROBE_INTERVAL_MS);
		void win.loadURL(`${FLOWSTOKEN_SITE_URL}/login`).catch(() => {
			finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.requestUnavailable")) });
		});
	});
}

export async function loginWithPasswordAndTurnstile(
	username: string,
	password: string,
): Promise<FlowstokenUserSnapshot> {
	assertFlowstokenRequestAllowed(getFlowstokenSession());
	const turnstile = await obtainTurnstileToken();
	return loginWithPassword(getFlowstokenSession(), username, password, turnstile);
}

function obtainTurnstileToken(): Promise<string> {
	return new Promise((resolve, reject) => {
		const ses = getFlowstokenSession();
		const win = new BrowserWindow({
			width: 380,
			height: 200,
			show: true,
			title: "安全验证",
			autoHideMenuBar: true,
			webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
		});
		let settled = false;
		const done = (err?: Error, token?: string) => {
			if (settled) return;
			settled = true;
			pendingLoginCancels.delete(cancel);
			clearInterval(poll);
			clearTimeout(timeout);
			if (!win.isDestroyed()) win.close();
			if (err) reject(err);
			else resolve(token as string);
		};
		const cancel = () => done(new FlowstokenApiError(mainT("flowstoken.errors.loginCancelled")));
		const poll = setInterval(() => {
			if (win.isDestroyed()) return;
			const title = win.getTitle();
			if (title.startsWith("FT_TURNSTILE:")) done(undefined, title.slice("FT_TURNSTILE:".length));
		}, 300);
		const timeout = setTimeout(
			() => done(new FlowstokenApiError(mainT("flowstoken.errors.loginTimedOut"))),
			LOGIN_TIMEOUT_MS,
		);
		win.on("closed", () => done(new FlowstokenApiError("未完成安全验证")));
		pendingLoginCancels.add(cancel);
		void win.loadURL(`${FLOWSTOKEN_SITE_URL}/desktop-turnstile.html`).catch(() => {
			done(new FlowstokenApiError(mainT("flowstoken.errors.requestUnavailable")));
		});
	});
}
