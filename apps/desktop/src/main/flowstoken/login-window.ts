import { BrowserWindow, session as electronSession } from "electron";
import { FLOWSTOKEN_SESSION_PARTITION, FLOWSTOKEN_SITE_URL } from "./constants.js";
import { FlowstokenApiError, fetchSelf, loginWithPassword } from "./newapi-client.js";
import type { FlowstokenUserSnapshot } from "./types.js";

export function getFlowstokenSession() {
	return electronSession.fromPartition(FLOWSTOKEN_SESSION_PARTITION);
}

export async function clearFlowstokenSession(): Promise<void> {
	await getFlowstokenSession().clearStorageData({ storages: ["cookies", "localstorage"] });
}

export async function probeExistingSession(): Promise<FlowstokenUserSnapshot | null> {
	try {
		return await fetchSelf(getFlowstokenSession());
	} catch {
		return null;
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
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			fn();
			if (!win.isDestroyed()) win.close();
		};
		const timer = setInterval(() => {
			void fetchSelf(ses)
				.then((user) => finish(() => resolve(user)))
				.catch(() => undefined);
		}, 1200);
		win.on("closed", () => finish(() => reject(new FlowstokenApiError("登录窗口已关闭"))));
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
