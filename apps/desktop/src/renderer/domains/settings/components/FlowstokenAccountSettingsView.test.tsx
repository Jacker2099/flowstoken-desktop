// @vitest-environment jsdom

import type { FlowstokenAccountSnapshot } from "@preload/api";
import { i18n, initI18n } from "@shared/i18n";
import { invalidateFlowstokenCatalog } from "@shared/store/flowstoken-catalog";
import { flowstokenCatalogAtom } from "@shared/store/model-catalog-atoms";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { beforeEach, expect, it, vi } from "vitest";
import { FlowstokenAccountSettingsView } from "./FlowstokenAccountSettingsView";
import {
	type FlowstokenAccountSettingsModel,
	useFlowstokenAccountSettingsModel,
} from "./useFlowstokenAccountSettingsModel";

const snapshot = (id: number): FlowstokenAccountSnapshot => ({
	loggedIn: true,
	user: { id, username: `user-${id}`, displayName: `Account ${id}`, quota: 10, usedQuota: 0, requestCount: 0 },
	balanceUsd: "$10.00",
	usedUsd: "$0.00",
	usage: [],
	siteUrl: "https://www.flowstoken.com",
	topupUrl: "https://www.flowstoken.com/console/topup",
	consoleUrl: "https://www.flowstoken.com/console",
	groups: [
		{
			groupId: "Research",
			providerId: "flowstoken-group-Research",
			labelZh: "研究组",
			tokenName: "long-managed-token-name",
			wired: true,
			enabled: true,
		},
	],
});
const model = (): FlowstokenAccountSettingsModel => ({
	snapshot: snapshot(8),
	busy: false,
	authorizing: false,
	error: null,
	username: "",
	password: "",
	setUsername: vi.fn(),
	setPassword: vi.fn(),
	refresh: vi.fn(async () => {}),
	loginBrowser: vi.fn(async () => {}),
	cancelLogin: vi.fn(async () => {}),
	loginPassword: vi.fn(async () => {}),
	logout: vi.fn(async () => {}),
	ensureKeys: vi.fn(async () => {}),
	openTopup: vi.fn(async () => {}),
	openConsole: vi.fn(async () => {}),
});
beforeEach(async () => {
	initI18n();
	await i18n.changeLanguage("zh");
	getDefaultStore().set(flowstokenCatalogAtom, null);
	invalidateFlowstokenCatalog();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

it("shows a new group without fixed three-group copy or a long implementation token name", () => {
	render(<FlowstokenAccountSettingsView model={model()} />);
	expect(screen.getByText("研究组")).toBeTruthy();
	expect(screen.getByText("模型分组")).toBeTruthy();
	expect(screen.queryByText("long-managed-token-name")).toBeNull();
	expect(screen.queryByText("三组通道")).toBeNull();
});

it("uses system-browser authorization with a waiting state instead of app password inputs", () => {
	const value = model();
	value.snapshot = { ...snapshot(8), loggedIn: false, user: null, groups: [] };
	value.authorizing = true;
	render(<FlowstokenAccountSettingsView model={value} />);
	expect(screen.getByRole("status").textContent).toContain("默认浏览器");
	expect(screen.getByRole("button", { name: "取消本次授权" })).toBeTruthy();
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(screen.queryByLabelText("密码")).toBeNull();
});

it("distinguishes a configured key from revoked account access", () => {
	const value = model();
	value.snapshot!.groups[0].enabled = false;
	render(<FlowstokenAccountSettingsView model={value} />);
	expect(screen.getByText("当前账户不可用")).toBeTruthy();
	expect(screen.queryByText("已启用")).toBeNull();
});

it("uses the same localized group title in cards and usage history", async () => {
	await i18n.changeLanguage("en");
	getDefaultStore().set(flowstokenCatalogAtom, {
		schema: 2,
		revision: "english",
		generated: 1,
		pricingVersion: "1",
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [
			{
				id: "Research",
				providerId: "flowstoken-group-Research",
				title: "研究组",
				titles: { en: "Research Studio" },
				subtitle: "",
				vendors: [],
			},
		],
	});
	const value = model();
	value.snapshot!.usage = [
		{ id: 1, createdAt: 1, modelName: "model", quota: 1, promptTokens: 2, completionTokens: 3, group: "Research" },
	];
	render(<FlowstokenAccountSettingsView model={value} />);
	expect(screen.getByText("Research Studio")).toBeTruthy();
	expect(screen.getByText(/ · Research Studio/)).toBeTruthy();
	expect(screen.queryByText("研究组")).toBeNull();
});

it("does not let a late refresh replace the newly broadcast account", async () => {
	let resolve!: (value: FlowstokenAccountSnapshot) => void;
	let listener!: (value: FlowstokenAccountSnapshot) => void;
	const pending = new Promise<FlowstokenAccountSnapshot>((done) => {
		resolve = done;
	});
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: {
			flowstoken: {
				refresh: vi.fn(() => pending),
				onAccountChanged: (callback: typeof listener) => {
					listener = callback;
					return vi.fn();
				},
			},
		},
	});
	const { result } = renderHook(() => useFlowstokenAccountSettingsModel());
	await act(async () => {
		listener(snapshot(8));
	});
	await act(async () => {
		resolve(snapshot(7));
		await pending;
	});
	expect(result.current.snapshot?.user?.id).toBe(8);
	expect(result.current.busy).toBe(false);
});

it("a same-account permission event wins over an older pending refresh", async () => {
	let listener!: (value: FlowstokenAccountSnapshot) => void;
	const old = deferred<FlowstokenAccountSnapshot>();
	const refresh = vi
		.fn()
		.mockResolvedValueOnce(snapshot(7))
		.mockImplementationOnce(() => old.promise);
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: {
			flowstoken: {
				refresh,
				onAccountChanged: (callback: typeof listener) => {
					listener = callback;
					return () => {};
				},
			},
		},
	});
	const { result } = renderHook(() => useFlowstokenAccountSettingsModel());
	await waitFor(() => expect(result.current.snapshot?.user?.id).toBe(7));
	let pending!: Promise<void>;
	act(() => {
		pending = result.current.refresh();
	});
	const revoked = snapshot(7);
	revoked.groups[0].enabled = false;
	revoked.lastError = "Access revoked";
	act(() => {
		listener(revoked);
	});
	await act(async () => {
		old.resolve(snapshot(7));
		await pending;
	});
	expect(result.current.snapshot?.groups[0].enabled).toBe(false);
	expect(result.current.error).toBe("Access revoked");
});

it("a same-account event also invalidates an older manual ensure result", async () => {
	let listener!: (value: FlowstokenAccountSnapshot) => void;
	const old = deferred<{ ok: boolean; snapshot: FlowstokenAccountSnapshot }>();
	const unwired = snapshot(7);
	unwired.groups[0].wired = false;
	const ensureKeys = vi.fn(() => old.promise);
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: {
			flowstoken: {
				refresh: async () => unwired,
				ensureKeys,
				onAccountChanged: (callback: typeof listener) => {
					listener = callback;
					return () => {};
				},
			},
		},
	});
	const { result } = renderHook(() => useFlowstokenAccountSettingsModel());
	await waitFor(() => expect(result.current.snapshot?.user?.id).toBe(7));
	expect(ensureKeys).not.toHaveBeenCalled();
	let pending!: Promise<void>;
	act(() => { pending = result.current.ensureKeys(); });
	await waitFor(() => expect(ensureKeys).toHaveBeenCalledTimes(1));
	const revoked = snapshot(7);
	revoked.groups[0].enabled = false;
	act(() => {
		listener(revoked);
	});
	await act(async () => {
		old.resolve({ ok: true, snapshot: snapshot(7) });
		await old.promise;
		await pending;
	});
	expect(result.current.snapshot?.groups[0].enabled).toBe(false);
});

it("reports a force catalog failure after ensure's own authoritative broadcast", async () => {
	let listener!: (value: FlowstokenAccountSnapshot) => void;
	const getCatalogSnapshot = vi.fn(async () => {
		throw new Error("Catalog is offline");
	});
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: {
			flowstoken: {
				refresh: async () => snapshot(7),
				getCatalogSnapshot,
				ensureKeys: async () => {
					const next = snapshot(7);
					listener(next);
					return { ok: true, snapshot: next };
				},
				onAccountChanged: (callback: typeof listener) => {
					listener = callback;
					return () => {};
				},
			},
		},
	});
	const { result } = renderHook(() => useFlowstokenAccountSettingsModel());
	await waitFor(() => expect(result.current.snapshot?.user?.id).toBe(7));
	await act(async () => {
		await result.current.ensureKeys();
	});
	expect(getCatalogSnapshot).toHaveBeenCalledWith({ force: true });
	expect(result.current.error).toBe("Catalog is offline");
	expect(result.current.busy).toBe(false);
});

it.each(["ensureKeys", "loginBrowser"] as const)("a late %s IPC rejection cannot replace a newer same-account event", async (action) => {
	let listener!: (value: FlowstokenAccountSnapshot) => void;
	const old = deferred<{ ok: boolean; snapshot: FlowstokenAccountSnapshot }>();
	Object.defineProperty(window, "vetta", { configurable: true, value: { flowstoken: {
		refresh: async () => snapshot(7),
		ensureKeys: () => old.promise,
		loginWithBrowser: () => old.promise,
		onAccountChanged: (callback: typeof listener) => { listener = callback; return () => {}; },
	} } });
	const { result } = renderHook(() => useFlowstokenAccountSettingsModel());
	await waitFor(() => expect(result.current.snapshot?.user?.id).toBe(7));
	let pending!: Promise<void>;
	act(() => { pending = result.current[action](); });
	const next = snapshot(7);
	next.groups[0].enabled = false;
	next.lastError = "New authoritative account state";
	act(() => { listener(next); });
	await act(async () => { old.reject(new Error("Obsolete action failure")); await pending; });
	expect(result.current.snapshot?.groups[0].enabled).toBe(false);
	expect(result.current.error).toBe("New authoritative account state");
});

it("an old logout reply cannot clear the new account's password input", async () => {
	let listener!: (value: FlowstokenAccountSnapshot) => void;
	const old = deferred<FlowstokenAccountSnapshot>();
	Object.defineProperty(window, "vetta", {
		configurable: true,
		value: {
			flowstoken: {
				refresh: async () => snapshot(7),
				logout: () => old.promise,
				onAccountChanged: (callback: typeof listener) => {
					listener = callback;
					return () => {};
				},
			},
		},
	});
	const { result } = renderHook(() => useFlowstokenAccountSettingsModel());
	await waitFor(() => expect(result.current.snapshot?.user?.id).toBe(7));
	let pending!: Promise<void>;
	act(() => {
		pending = result.current.logout();
	});
	act(() => {
		listener(snapshot(8));
		result.current.setPassword("new-account-input");
	});
	await act(async () => {
		old.resolve({ ...snapshot(7), loggedIn: false, user: null, groups: [] });
		await pending;
	});
	expect(result.current.password).toBe("new-account-input");
	expect(result.current.snapshot?.user?.id).toBe(8);
});
