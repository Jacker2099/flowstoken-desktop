import type { IpcRenderer } from "electron";
import type { DesktopApi } from "../api.js";

export function createFlowstokenApi(ipc: IpcRenderer): Pick<DesktopApi, "flowstoken"> {
	return {
		flowstoken: {
			getSnapshot: () => ipc.invoke("flowstoken:account:get-snapshot"),
			loginWithBrowser: () => ipc.invoke("flowstoken:account:login-browser"),
			loginWithPassword: (username, password) => ipc.invoke("flowstoken:account:login-password", username, password),
			logout: () => ipc.invoke("flowstoken:account:logout"),
			ensureKeys: (groupIds) => ipc.invoke("flowstoken:account:ensure-keys", groupIds),
			refresh: () => ipc.invoke("flowstoken:account:refresh"),
			openExternal: (url) => ipc.invoke("flowstoken:account:open-external", url),
		},
	};
}
