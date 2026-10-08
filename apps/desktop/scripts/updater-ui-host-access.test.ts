// @vitest-environment jsdom
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type * as HostAccessModule from "../src/preload/host-access.js";
import type * as AccountViewModule from "../src/renderer/domains/settings/components/FlowstokenAccountSettingsView.js";
import type { FlowstokenAccountSettingsModel } from "../src/renderer/domains/settings/components/useFlowstokenAccountSettingsModel.js";
import type * as HostApiModule from "../src/renderer/shared/host-api.js";

interface TestElement {
	getElement(): Promise<TestElement>;
	waitForDisplayed(options?: { timeout: number }): Promise<void>;
	getText(): Promise<string>;
	getAttribute(name: string): Promise<string>;
	click(): void;
}

const sourceRoot =
	process.env.FLOWSTOKEN_TEST_SOURCE_ROOT ??
	process.env.VETTA_RELEASE_SOURCE_ROOT ??
	resolve(import.meta.dirname, "../../..");
const sourceUrl = (file: string) => pathToFileURL(join(sourceRoot, "apps/desktop/src", file)).href;

let createHostAccessGate: typeof HostAccessModule.createHostAccessGate;
let FlowstokenAccountSettingsView: typeof AccountViewModule.FlowstokenAccountSettingsView;

beforeAll(async () => {
	// Cold UI dependency loading belongs to setup, outside the HostGate/UI behavior's timeout.
	vi.resetModules();
	({ createHostAccessGate } = await import(sourceUrl("preload/host-access.ts")));
	({ FlowstokenAccountSettingsView } = await import(
		sourceUrl("renderer/domains/settings/components/FlowstokenAccountSettingsView.tsx")
	));
});

let previousApi: PropertyDescriptor | undefined;

afterEach(() => {
	if (previousApi) Object.defineProperty(window, "vetta", previousApi);
	else Reflect.deleteProperty(window, "vetta");
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	document.body.innerHTML = "";
	window.location.hash = "";
});

it("runs the updater spec through the account UI while raw Host API access remains denied", async () => {
	previousApi = Object.getOwnPropertyDescriptor(window, "vetta");
	vi.stubEnv("VETTA_E2E", "1");
	vi.stubEnv("VETTA_E2E_PACKAGED", "1");
	const handlers = new Map<string, () => unknown>();
	const gate = createHostAccessGate({
		flowstoken: {
			getSnapshot: async () => {
				const handler = handlers.get("flowstoken:account:get-snapshot");
				if (!handler) throw new Error("Account fixture is missing");
				return handler();
			},
			refresh: async () => {
				const handler = handlers.get("flowstoken:account:refresh");
				if (!handler) throw new Error("Account fixture is missing");
				return handler();
			},
		},
	});
	Object.defineProperty(window, "vetta", { configurable: true, value: { ...gate.api, hostAccess: gate.hostAccess } });
	// Use the real renderer facade, which owns the once-claimed token in the packaged app.
	const { hostApi }: typeof HostApiModule = await import(sourceUrl("renderer/shared/host-api.ts"));
	expect(() => gate.hostAccess.claim()).toThrow(/already been claimed/);
	expect(() => gate.api.flowstoken.getSnapshot()).toThrow("Host API access denied");

	const session = {};
	const mainWindow = {
		id: 1,
		isDestroyed: () => false,
		getTitle: () => "FlowsToken",
		close: vi.fn(),
		webContents: { session, getURL: () => "file:///fixture/renderer/index.html", send: vi.fn() },
	};
	const electron = {
		app: { getVersion: () => "0.6.3" },
		BrowserWindow: { getAllWindows: () => [mainWindow] },
		session: { fromPartition: () => session },
		ipcMain: {
			removeHandler: (channel: string) => {
				handlers.delete(channel);
			},
			handle: (channel: string, handler: () => unknown) => {
				handlers.set(channel, handler);
			},
		},
	};
	let signedIn = false;
	let route = "";
	const routes: string[] = [];
	const phaseReads: string[] = [];
	let phases: string[] = [];
	let phase = "idle";
	const noop = async () => {};
	const renderRoute = async () => {
		const next = window.location.hash.slice(1);
		if (next === route) return;
		route = next;
		routes.push(route);
		if (!signedIn) throw new Error("Renderer has not consumed the account fixture");
		if (route === "/settings/flowstoken") {
			const snapshot = await hostApi.flowstoken.refresh();
			const model: FlowstokenAccountSettingsModel = {
				snapshot,
					busy: false,
					authorizing: false,
				error: null,
				username: "",
				password: "",
				setUsername: () => {},
				setPassword: () => {},
				refresh: noop,
					loginBrowser: noop,
					cancelLogin: noop,
				loginPassword: noop,
				logout: noop,
				ensureKeys: noop,
				openTopup: noop,
				openConsole: noop,
			};
			document.body.innerHTML = renderToStaticMarkup(createElement(FlowstokenAccountSettingsView, { model }));
		} else if (route === "/settings/general") {
			document.body.innerHTML =
				'<div>0.6.3</div><button data-testid="updater-check">Check</button><div data-testid="updater-detail">0.6.3</div><button data-testid="updater-primary">Download</button>';
		}
	};
	const findElement = (selector: string): TestElement => {
		const locate = () => {
			const textSelector = /^(\w+)(\*?)=(.+)$/.exec(selector);
			if (!textSelector) return document.querySelector(selector);
			const [, tag, partial, value] = textSelector;
			return [...document.querySelectorAll(tag)].find((node) =>
				partial ? node.textContent?.includes(value) : node.textContent === value,
			);
		};
		const element: TestElement = {
			getElement: async () => element,
			waitForDisplayed: async () => {
				expect(locate(), `Missing UI element: ${selector}`).toBeTruthy();
			},
			getText: async () => locate()?.textContent ?? "",
			getAttribute: async (name) => {
				expect(name).toBe("data-updater-phase");
				phase = phases.shift() ?? phase;
				phaseReads.push(phase);
				return phase;
			},
			click: () => {
				phases = selector.includes("updater-primary")
					? ["ready"]
					: ["checking", process.platform === "linux" ? "available" : "idle"];
			},
		};
		return element;
	};
	vi.stubGlobal("$", findElement);
	vi.stubGlobal("expect", expect);
	vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
	vi.stubGlobal("browser", {
		execute: async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => {
			const result = await Reflect.apply(callback, undefined, args);
			await renderRoute();
			return result;
		},
		electron: {
			execute: async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) =>
				Reflect.apply(callback, undefined, [electron, ...args]),
		},
		refresh: async () => {
			const snapshot = await hostApi.flowstoken.getSnapshot();
			signedIn = snapshot.loggedIn && Boolean(snapshot.user);
		},
		getWindowHandles: async () => ["main"],
		switchToWindow: async () => {},
		getUrl: async () => `file:///fixture/renderer/index.html${window.location.hash}`,
		waitUntil: async (condition: () => Promise<boolean>) => {
			if (!(await condition())) throw new Error("Browser condition did not become true");
		},
	});
	let runSpec: (() => Promise<void>) | undefined;
	vi.stubGlobal("describe", (_name: string, body: () => void) => body());
	vi.stubGlobal(
		"it",
		Object.assign(
			(_name: string, body: () => Promise<void>) => {
				runSpec = body;
			},
			{ skip: () => {} },
		),
	);
	await import("../e2e/updater.e2e.js");
	if (!runSpec) throw new Error("Packaged updater spec was not collected");
	await runSpec();
	expect(routes).toEqual(["/settings/flowstoken", "/settings/general"]);
	expect(phaseReads).toEqual(process.platform === "linux" ? ["checking", "available", "ready"] : ["checking", "idle"]);
	// The harness never learns or reclaims the token, and cannot make a raw API call even afterwards.
	expect(() => gate.api.flowstoken.getSnapshot()).toThrow("Host API access denied");
	expect(() => gate.hostAccess.claim()).toThrow(/already been claimed/);
});
