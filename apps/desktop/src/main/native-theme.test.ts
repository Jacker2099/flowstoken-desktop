import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	events: new Map<string, () => void>(),
	systemDark: true,
	themeSource: "system" as "light" | "dark" | "system",
	window: {
		isDestroyed: vi.fn(() => false),
		setVibrancy: vi.fn(),
		setBackgroundColor: vi.fn(),
		webContents: { send: vi.fn() },
	},
}));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (name: string, callback: (...args: unknown[]) => unknown) => fixture.handlers.set(name, callback),
	},
	nativeTheme: {
		get themeSource() {
			return fixture.themeSource;
		},
		set themeSource(value: "light" | "dark" | "system") {
			fixture.themeSource = value;
		},
		get shouldUseDarkColors() {
			return fixture.themeSource === "dark" || (fixture.themeSource === "system" && fixture.systemDark);
		},
		on: (name: string, callback: () => void) => fixture.events.set(name, callback),
	},
}));
vi.mock("./window-manager.js", () => ({ getMainWindow: () => fixture.window }));
const { registerNativeThemeIpc } = await import("./native-theme.js");

beforeEach(() => {
	vi.clearAllMocks();
	fixture.handlers.clear();
	fixture.events.clear();
	fixture.themeSource = "system";
	fixture.systemDark = true;
	registerNativeThemeIpc();
});

it.each(["light", "dark", "system"] as const)(
	"applies %s to the native surface before acknowledging the renderer",
	(mode) => {
		fixture.handlers.get("vetta:theme:set")?.({}, mode);
		expect(fixture.themeSource).toBe(mode);
		expect(fixture.handlers.get("vetta:theme:get-native")?.()).toEqual({
			source: mode,
			shouldUseDarkColors: mode !== "light",
		});
		if (process.platform === "darwin") expect(fixture.window.setVibrancy).toHaveBeenCalledWith("sidebar");
		else expect(fixture.window.setBackgroundColor).toHaveBeenCalledWith(mode === "light" ? "#f5f5f7" : "#161616");
	},
);

it("keeps system mode responsive and ignores no explicit dark choice", () => {
	fixture.handlers.get("vetta:theme:set")?.({}, "system");
	fixture.systemDark = false;
	fixture.events.get("updated")?.();
	expect(fixture.window.webContents.send).toHaveBeenLastCalledWith("vetta:theme:native-changed", {
		shouldUseDarkColors: false,
	});
	fixture.handlers.get("vetta:theme:set")?.({}, "dark");
	fixture.events.get("updated")?.();
	expect(fixture.window.webContents.send).toHaveBeenLastCalledWith("vetta:theme:native-changed", {
		shouldUseDarkColors: true,
	});
});

it("rejects malformed modes without replacing the existing preference", () => {
	expect(() => fixture.handlers.get("vetta:theme:set")?.({}, "invalid")).toThrow("Invalid native theme mode");
	expect(fixture.themeSource).toBe("system");
});
