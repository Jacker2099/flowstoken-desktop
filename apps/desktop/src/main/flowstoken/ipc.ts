import { BrowserWindow, ipcMain, shell } from "electron";
import { mainT } from "../i18n/index.js";
import {
	ensureGroupKeysAndProviders,
	getAccountSnapshot,
	getCatalogAndRefreshProviders,
	getCatalogSnapshot,
	loginWithBrowser,
	loginWithCredentials,
	logoutAccount,
	refreshAccount,
	setSnapshotBroadcastListener,
} from "./account-service.js";
import { isValidBillingGroupId } from "./group-catalog.js";
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
	GET_CATALOG: "flowstoken:catalog:get",
	GET_CATALOG_SNAPSHOT: "flowstoken:catalog:get-snapshot",
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
	ipcMain.handle(CHANNELS.GET_CATALOG, async (_event, options: unknown) =>
		getCatalogAndRefreshProviders({
			force: typeof options === "object" && options !== null && "force" in options && options.force === true,
		}),
	);
	ipcMain.handle(CHANNELS.GET_CATALOG_SNAPSHOT, async (_event, options: unknown) =>
		getCatalogSnapshot({
			force: typeof options === "object" && options !== null && "force" in options && options.force === true,
		}),
	);
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
		if (groupIds !== undefined && (!Array.isArray(groupIds) || !groupIds.every(isValidBillingGroupId)))
			return { ok: false, created: [], reused: [], error: mainT("flowstoken.errors.groupUnavailable") };
		const ids = groupIds === undefined ? undefined : (groupIds as string[]);
		const result = await ensureGroupKeysAndProviders(ids, { allowManualOverride: true });
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
