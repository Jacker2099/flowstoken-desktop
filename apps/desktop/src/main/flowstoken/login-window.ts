import { BrowserWindow, session as electronSession } from "electron";
import { FLOWSTOKEN_SESSION_PARTITION, FLOWSTOKEN_SITE_URL } from "./constants.js";
import {
	clearCachedAccessToken,
	FlowstokenApiError,
	fetchSelf,
	loginWithPassword,
	refreshAuth,
	setCachedAccessToken,
} from "./newapi-client.js";
import type { FlowstokenUserSnapshot } from "./types.js";

export function getFlowstokenSession() {
	return electronSession.fromPartition(FLOWSTOKEN_SESSION_PARTITION);
}

export async function clearFlowstokenSession(): Promise<void> {
	clearCachedAccessToken();
	await getFlowstokenSession().clearStorageData({ storages: ["cookies", "localstorage"] });
}

export async function probeExistingSession(): Promise<FlowstokenUserSnapshot | null> {
	try {
		return await fetchSelf(getFlowstokenSession());
	} catch {
		return null;
	}
}

type InPageRefreshResult = {
	ok?: boolean;
	accessToken?: string | null;
	user?: Record<string, unknown> | null;
};

function mapUserFromUnknown(data: Record<string, unknown>): FlowstokenUserSnapshot {
	return {
		id: Number(data.id),
		username: String(data.username ?? ""),
		displayName: String(data.display_name || data.username || ""),
		email: data.email ? String(data.email) : undefined,
		group: data.group ? String(data.group) : undefined,
		quota: Number(data.quota ?? 0),
		usedQuota: Number(data.used_quota ?? 0),
		requestCount: Number(data.request_count ?? 0),
	};
}

/** Prefer in-page refresh so Path-scoped SameSite=Strict cookies attach like the SPA. */
async function probeLoginInPage(win: BrowserWindow): Promise<FlowstokenUserSnapshot | null> {
	if (win.isDestroyed() || win.webContents.isDestroyed()) return null;
	try {
		const result = (await win.webContents.executeJavaScript(
			`(async () => {
				try {
					const res = await fetch('/api/user/auth/refresh', {
						method: 'POST',
						credentials: 'include',
						cache: 'no-store',
						headers: { 'Accept': 'application/json', 'Cache-Control': 'no-store' },
					});
					const body = await res.json().catch(() => null);
					if (res.ok && body && body.success !== false && body.data) {
						const data = body.data;
						const accessToken = data.access_token || data.accessToken || data.token || null;
						const user = data.user && typeof data.user === 'object' ? data.user : data;
						if (accessToken) return { ok: true, accessToken, user };
					}
				} catch {}
				try {
					const resSelf = await fetch('/api/user/self', {
						method: 'GET',
						credentials: 'include',
						headers: { 'Accept': 'application/json' },
					});
					if (resSelf.ok) {
						const body = await resSelf.json().catch(() => null);
						if (body && body.success !== false && body.data) {
							return { ok: true, user: body.data };
						}
					}
				} catch {}
				try {
					const raw = window.localStorage.getItem('user');
					if (raw) {
						const localUser = JSON.parse(raw);
						if (localUser && (localUser.id || localUser.username)) {
							const accessToken = localUser.token || localUser.access_token || null;
							return { ok: true, accessToken, user: localUser };
						}
					}
				} catch {}
				return { ok: false };
			})()`,
			true,
		)) as InPageRefreshResult | null;

		if (!result?.ok) return null;
		if (result.accessToken) {
			setCachedAccessToken(result.accessToken);
		}
		if (result.user && result.user.id !== undefined) {
			return mapUserFromUnknown(result.user);
		}
		return await fetchSelf(getFlowstokenSession());
	} catch {
		return null;
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

export function loginViaBrowserWindow(): Promise<FlowstokenUserSnapshot> {
	return new Promise((resolve, reject) => {
		const ses = getFlowstokenSession();
		const win = new BrowserWindow({
			width: 480,
			height: 740,
			title: "登录 FlowsToken",
			autoHideMenuBar: true,
			webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
		});
		let settled = false;
		let probeInFlight = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			win.webContents.removeListener("did-navigate", onNavigate);
			win.webContents.removeListener("did-navigate-in-page", onNavigate);
			win.webContents.removeListener("did-finish-load", onNavigate);
			void ses.cookies.flushStore().catch(() => {});
			fn();
			if (!win.isDestroyed()) win.close();
		};

		const tryProbe = async () => {
			if (settled || probeInFlight || win.isDestroyed()) return;
			probeInFlight = true;
			try {
				const fromPage = await probeLoginInPage(win);
				if (fromPage) {
					finish(() => resolve(fromPage));
					return;
				}
				const { user } = await refreshAuth(ses);
				finish(() => resolve(user));
			} catch {
				// Still logged out — keep polling.
			} finally {
				probeInFlight = false;
			}
		};

		const onNavigate = () => {
			if (settled || win.isDestroyed()) return;
			if (looksLikeLoggedInUrl(win.webContents.getURL())) void tryProbe();
		};

		const timer = setInterval(() => {
			void tryProbe();
		}, 800);

		win.webContents.on("did-navigate", onNavigate);
		win.webContents.on("did-navigate-in-page", onNavigate);
		win.webContents.on("did-finish-load", onNavigate);

		win.on("closed", () => {
			finish(() => reject(new FlowstokenApiError("登录窗口已关闭")));
		});

		void win.loadURL(`${FLOWSTOKEN_SITE_URL}/login`);
	});
}

export async function loginWithPasswordAndTurnstile(
	username: string,
	password: string,
): Promise<FlowstokenUserSnapshot> {
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
			clearInterval(poll);
			if (!win.isDestroyed()) win.close();
			if (err) reject(err);
			else resolve(token as string);
		};
		const poll = setInterval(() => {
			if (win.isDestroyed()) return;
			const title = win.getTitle();
			if (title.startsWith("FT_TURNSTILE:")) done(undefined, title.slice("FT_TURNSTILE:".length));
		}, 300);
		win.on("closed", () => done(new FlowstokenApiError("未完成安全验证")));
		void win.loadURL(`${FLOWSTOKEN_SITE_URL}/desktop-turnstile.html`);
	});
}
