import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
	installUpdaterAuthFixture,
	UPDATER_ACCOUNT_SNAPSHOT,
	type UpdaterFixtureElectron,
	type UpdaterFixtureWindow,
} from "../e2e/updater-auth-fixture.js";

function fixture() {
	const accountSession = {};
	const defaultSession = {};
	const closed: number[] = [];
	const sent: Array<{ id: number; channel: string; args: unknown[] }> = [];
	const handlers = new Map<string, () => unknown>();
	const makeWindow = (id: number, url: string, session: object, title = "", destroyed = false): UpdaterFixtureWindow => ({
		id,
		isDestroyed: () => destroyed,
		getTitle: () => title,
		close: () => { closed.push(id); },
		webContents: {
			session,
			getURL: () => url,
			send: (channel, ...args) => { sent.push({ id, channel, args }); },
		},
	});
	const windows = [
		makeWindow(1, "file:///fixture/app.asar/renderer/index.html", defaultSession),
		makeWindow(2, "https://www.flowstoken.com/login?next=console", accountSession),
		makeWindow(3, "", accountSession, "登录 FlowsToken"),
		makeWindow(4, "https://www.flowstoken.com/console", accountSession),
		makeWindow(5, "https://example.com/login", accountSession),
		makeWindow(6, "https://www.flowstoken.com/login", defaultSession),
		makeWindow(7, "https://www.flowstoken.com/login", accountSession, "", true),
		makeWindow(8, "file:///fixture/app.asar/renderer/remote-desktop-host.html", defaultSession),
	];
	const electron: UpdaterFixtureElectron = {
		BrowserWindow: { getAllWindows: () => windows },
		session: { fromPartition: (partition) => {
			expect(partition).toBe("persist:flowstoken-account");
			return accountSession;
		} },
		ipcMain: {
			removeHandler: (channel) => { handlers.delete(channel); },
			handle: (channel, handler) => { handlers.set(channel, handler); },
		},
	};
	return { electron, windows, closed, sent, handlers };
}

function serializedInstaller(e2e = "1"): typeof installUpdaterAuthFixture {
	// Exercise WDIO's serialization boundary: no module imports or outer constants may be referenced.
	return runInNewContext(`(${installUpdaterAuthFixture.toString()})`, { URL, process: { env: { VETTA_E2E: e2e } } });
}

describe("isolated updater account fixture", () => {
	it("replaces account IPC, closes only its login windows, and preserves updater IPC and other windows", () => {
		const state = fixture();
		const updater = () => "real-updater-boundary";
		state.handlers.set("vetta:updater:check", updater);
		const result = serializedInstaller()(state.electron, UPDATER_ACCOUNT_SNAPSHOT);
		expect(result).toEqual({ mainWindowId: 1, closedLoginWindowIds: [2, 3] });
		expect(state.closed).toEqual([2, 3]);
		expect(state.handlers.get("flowstoken:account:get-snapshot")?.()).toEqual(UPDATER_ACCOUNT_SNAPSHOT);
		expect(state.handlers.get("flowstoken:account:refresh")?.()).toEqual(UPDATER_ACCOUNT_SNAPSHOT);
		expect(state.handlers.get("flowstoken:account:login-browser")?.()).toEqual({ ok: true, snapshot: UPDATER_ACCOUNT_SNAPSHOT });
		expect(state.handlers.get("vetta:updater:check")).toBe(updater);
		expect(state.handlers.size).toBe(4);

		state.windows[0].webContents.send("flowstoken:account:changed", { loggedIn: false });
		state.windows[0].webContents.send("vetta:updater:state", { phase: "checking" });
		state.windows[3].webContents.send("flowstoken:account:changed", { loggedIn: false });
		expect(state.sent).toEqual([
			{ id: 1, channel: "flowstoken:account:changed", args: [UPDATER_ACCOUNT_SNAPSHOT] },
			{ id: 1, channel: "vetta:updater:state", args: [{ phase: "checking" }] },
			{ id: 4, channel: "flowstoken:account:changed", args: [{ loggedIn: false }] },
		]);
	});

	it("rejects non-E2E processes and missing user snapshots without mutating IPC or windows", () => {
		const state = fixture();
		expect(() => serializedInstaller("0")(state.electron, UPDATER_ACCOUNT_SNAPSHOT)).toThrow(/E2E process marker/);
		expect(() => serializedInstaller()(state.electron, { ...UPDATER_ACCOUNT_SNAPSHOT, user: null })).toThrow(/user snapshot/);
		expect(state.handlers.size).toBe(0);
		expect(state.closed).toEqual([]);
	});

	it("refuses an ambiguous main renderer before installing handlers or closing any window", () => {
		const state = fixture();
		state.windows.push({ ...state.windows[0], id: 9 });
		expect(() => serializedInstaller()(state.electron, UPDATER_ACCOUNT_SNAPSHOT)).toThrow(/Expected one main renderer, found 2/);
		expect(state.handlers.size).toBe(0);
		expect(state.closed).toEqual([]);
	});
});
