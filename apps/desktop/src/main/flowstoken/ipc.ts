import { ipcMain, shell } from "electron";
import {
	ensureGroupKeysAndProviders,
	getAccountSnapshot,
	loginWithBrowser,
	loginWithCredentials,
	logoutAccount,
	refreshAccount,
} from "./account-service.js";
import type { FlowstokenGroupId } from "./constants.js";

const CHANNELS = {
	GET_SNAPSHOT: "flowstoken:account:get-snapshot",
	LOGIN_BROWSER: "flowstoken:account:login-browser",
	LOGIN_PASSWORD: "flowstoken:account:login-password",
	LOGOUT: "flowstoken:account:logout",
	ENSURE_KEYS: "flowstoken:account:ensure-keys",
	REFRESH: "flowstoken:account:refresh",
	OPEN_EXTERNAL: "flowstoken:account:open-external",
} as const;

export function registerFlowstokenAccountIpc(): () => void {
	ipcMain.handle(CHANNELS.GET_SNAPSHOT, async () => getAccountSnapshot({ includeUsage: true }));
	ipcMain.handle(CHANNELS.LOGIN_BROWSER, async () => loginWithBrowser());
	ipcMain.handle(CHANNELS.LOGIN_PASSWORD, async (_event, username: unknown, password: unknown) => {
		if (typeof username !== "string" || typeof password !== "string") {
			return { ok: false, error: "用户名或密码无效" };
		}
		return loginWithCredentials(username, password);
	});
	ipcMain.handle(CHANNELS.LOGOUT, async () => logoutAccount());
	ipcMain.handle(CHANNELS.ENSURE_KEYS, async (_event, groupIds: unknown) => {
		const ids = Array.isArray(groupIds)
			? (groupIds.filter((id): id is FlowstokenGroupId => typeof id === "string") as FlowstokenGroupId[])
			: undefined;
		return ensureGroupKeysAndProviders(ids);
	});
	ipcMain.handle(CHANNELS.REFRESH, async () => refreshAccount());
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
