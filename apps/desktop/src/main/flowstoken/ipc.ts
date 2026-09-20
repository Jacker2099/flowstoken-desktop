import { BrowserWindow, ipcMain, shell } from "electron";
import {
	ensureGroupKeysAndProviders,
	getAccountSnapshot,
	loginWithBrowser,
	loginWithCredentials,
	logoutAccount,
	refreshAccount,
	setSnapshotBroadcastListener,
} from "./account-service.js";
import type { FlowstokenGroupId } from "./constants.js";
import type { FlowstokenAccountSnapshot } from "./types.js";

const CHANNELS = {
	GET_SNAPSHOT: "flowstoken:account:get-snapshot",
	LOGIN_BROWSER: "flowstoken:account:login-browser",
	LOGIN_PASSWORD: "flowstoken:account:login-password",
	LOGOUT: "flowstoken:account:logout",
	ENSURE_KEYS: "flowstoken:account:ensure-keys",
	REFRESH: "flowstoken:account:refresh",
	OPEN_EXTERNAL: "flowstoken:account:open-external",
	ACCOUNT_CHANGED: "flowstoken:account:changed",
} as const;

function broadcastAccountSnapshot(snapshot: FlowstokenAccountSnapshot): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(CHANNELS.ACCOUNT_CHANGED, snapshot);
		}
	}
}

export function registerFlowstokenAccountIpc(): () => void {
	setSnapshotBroadcastListener(broadcastAccountSnapshot);
	ipcMain.handle(CHANNELS.GET_SNAPSHOT, async () => getAccountSnapshot({ includeUsage: true }));
	ipcMain.handle(CHANNELS.LOGIN_BROWSER, async () => {
		const result = await loginWithBrowser();
		if (result.snapshot) broadcastAccountSnapshot(result.snapshot);
		return result;
	});
	ipcMain.handle(CHANNELS.LOGIN_PASSWORD, async (_event, username: unknown, password: unknown) => {
		if (typeof username !== "string" || typeof password !== "string") {
			return { ok: false, error: "用户名或密码无效" };
		}
		const result = await loginWithCredentials(username, password);
		if (result.snapshot) broadcastAccountSnapshot(result.snapshot);
		return result;
	});
	ipcMain.handle(CHANNELS.LOGOUT, async () => {
		const snapshot = await logoutAccount();
		broadcastAccountSnapshot(snapshot);
		return snapshot;
	});
	ipcMain.handle(CHANNELS.ENSURE_KEYS, async (_event, groupIds: unknown) => {
		const ids = Array.isArray(groupIds)
			? (groupIds.filter((id): id is FlowstokenGroupId => typeof id === "string") as FlowstokenGroupId[])
			: undefined;
		const result = await ensureGroupKeysAndProviders(ids);
		if (result.snapshot) broadcastAccountSnapshot(result.snapshot);
		return result;
	});
	ipcMain.handle(CHANNELS.REFRESH, async () => {
		const snapshot = await refreshAccount();
		broadcastAccountSnapshot(snapshot);
		return snapshot;
	});
	ipcMain.handle(CHANNELS.OPEN_EXTERNAL, async (_event, url: unknown) => {
		if (typeof url !== "string" || !/^https:\/\/([\w.-]+\.)?flowstoken\.com(\/|$)/i.test(url)) {
			throw new Error("仅允许打开 FlowsToken 官网链接");
		}
		await shell.openExternal(url);
	});
	return () => {
		for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
	};
}

export const FLOWSTOKEN_ACCOUNT_CHANNELS = CHANNELS;
