import type { FlowstokenAccountSnapshot } from "../src/preload/api-types/flowstoken.js";

/** Synthetic account only for reaching the updater UI; this never proves real authentication. */
export const UPDATER_ACCOUNT_SNAPSHOT: FlowstokenAccountSnapshot = {
	loggedIn: true,
	user: {
		id: 1,
		username: "updater-e2e-fixture",
		displayName: "Updater E2E fixture",
		quota: 0,
		usedQuota: 0,
		requestCount: 0,
	},
	balanceUsd: "$0.0000",
	usedUsd: "$0.0000",
	groups: [],
	usage: [],
	siteUrl: "https://www.flowstoken.com",
	topupUrl: "https://www.flowstoken.com/console/topup",
	consoleUrl: "https://www.flowstoken.com/console",
};

/** Minimal public Electron surface used by the serialized main-process fixture. */
export interface UpdaterFixtureWindow {
	id: number;
	isDestroyed(): boolean;
	getTitle(): string;
	close(): void;
	webContents: {
		session: object;
		getURL(): string;
		send(channel: string, ...args: unknown[]): void;
	};
}

export interface UpdaterFixtureElectron {
	BrowserWindow: { getAllWindows(): UpdaterFixtureWindow[] };
	session: { fromPartition(partition: string): object };
	ipcMain: {
		removeHandler(channel: string): void;
		handle(channel: string, listener: () => unknown): void;
	};
}

/**
 * Runs through browser.electron.execute in the disposable WDIO app process.
 * Only account IPC is replaced: updater IPC and every updater assertion remain real.
 * Do not reference module-scoped values here: WDIO serializes this function.
 */
export function installUpdaterAuthFixture(
	electron: UpdaterFixtureElectron,
	snapshot: FlowstokenAccountSnapshot,
): { mainWindowId: number; closedLoginWindowIds: number[] } {
	if (process.env.VETTA_E2E !== "1") throw new Error("Updater account fixture requires the E2E process marker");
	if (!snapshot.loggedIn || !snapshot.user) throw new Error("Updater account fixture requires a user snapshot");
	const windows = electron.BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
	const mainWindows = windows.filter((window) => {
		try {
			const url = new URL(window.webContents.getURL());
			return url.protocol === "file:" && url.pathname.endsWith("/index.html");
		} catch {
			return false;
		}
	});
	if (mainWindows.length !== 1) throw new Error(`Expected one main renderer, found ${mainWindows.length}`);
	const main = mainWindows[0];
	for (const channel of ["flowstoken:account:get-snapshot", "flowstoken:account:refresh"]) {
		electron.ipcMain.removeHandler(channel);
		electron.ipcMain.handle(channel, () => snapshot);
	}
	electron.ipcMain.removeHandler("flowstoken:account:login-browser");
	electron.ipcMain.handle("flowstoken:account:login-browser", () => ({ ok: true, snapshot }));

	// Closing an already-open login window settles its original IPC asynchronously.
	// Its late account notification must not overwrite the synthetic updater-only session.
	const send = main.webContents.send.bind(main.webContents);
	main.webContents.send = (channel, ...args) => {
		if (channel === "flowstoken:account:changed") send(channel, snapshot);
		else send(channel, ...args);
	};

	const accountSession = electron.session.fromPartition("persist:flowstoken-account");
	const closedLoginWindowIds: number[] = [];
	for (const window of windows) {
		if (window === main || window.webContents.session !== accountSession) continue;
		const rawUrl = window.webContents.getURL();
		let isLogin = rawUrl === "" && window.getTitle() === "登录 FlowsToken";
		try {
			const url = new URL(rawUrl);
			isLogin = url.protocol === "https:" && url.hostname === "www.flowstoken.com" &&
				(url.pathname === "/login" || url.pathname === "/login/" || url.pathname === "/desktop-turnstile.html");
		} catch {
			// A just-created login window can still have an empty URL.
		}
		if (!isLogin) continue;
		closedLoginWindowIds.push(window.id);
		window.close();
	}
	return { mainWindowId: main.id, closedLoginWindowIds };
}
