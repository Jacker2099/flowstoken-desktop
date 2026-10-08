import { ipcMain, nativeTheme } from "electron";
import { getMainWindow } from "./window-manager.js";

/** Register before loading the renderer so its first visible frame can match the native surface. */
export function registerNativeThemeIpc(): void {
	const updateWindow = () => {
		const window = getMainWindow();
		if (!window || window.isDestroyed()) return;
		if (process.platform === "darwin") window.setVibrancy("sidebar");
		else window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#161616" : "#f5f5f7");
	};

	ipcMain.handle("vetta:theme:set", (_event, mode: unknown) => {
		if (mode !== "light" && mode !== "dark" && mode !== "system") throw new Error("Invalid native theme mode");
		nativeTheme.themeSource = mode;
		updateWindow();
	});
	ipcMain.handle("vetta:theme:get-native", () => ({
		source: nativeTheme.themeSource,
		shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
	}));
	nativeTheme.on("updated", () => {
		updateWindow();
		const window = getMainWindow();
		if (!window || window.isDestroyed()) return;
		window.webContents.send("vetta:theme:native-changed", {
			shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
		});
	});
}
