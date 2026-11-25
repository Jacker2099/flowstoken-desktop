import { ipcMain } from "electron";
import { captureElementScreenshot } from "../browser-automation/element-capture-service.js";
import { getDesktopMcpServerStatus } from "../mcp-server/mcp-server-lifecycle.js";

/** Design Mode 元素拾取的截图桥：校验在业务服务内，这里只做参数转发。 */
export function registerBrowserCaptureIpc(): () => void {
	ipcMain.handle("vetta:browser:capture-element", async (_event, webContentsId: unknown, rect: unknown) =>
		captureElementScreenshot(webContentsId, rect),
	);
	ipcMain.handle("vetta:mcp-server:status", async () => getDesktopMcpServerStatus());
	return () => {
		ipcMain.removeHandler("vetta:browser:capture-element");
		ipcMain.removeHandler("vetta:mcp-server:status");
	};
}
