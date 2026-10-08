import type { IpcRenderer } from "electron";
import type { DesktopApi } from "../api.js";
import type { FlowstokenAccountSnapshot } from "../api-types/flowstoken.js";

export function createFlowstokenApi(ipc: IpcRenderer): Pick<DesktopApi, "flowstoken"> {
	return {
		flowstoken: {
			getSnapshot: () => ipc.invoke("flowstoken:account:get-snapshot"),
			loginWithBrowser: () => ipc.invoke("flowstoken:account:login-browser"),
			cancelLogin: () => ipc.invoke("flowstoken:account:cancel-login"),
			loginWithPassword: (username, password) => ipc.invoke("flowstoken:account:login-password", username, password),
			logout: () => ipc.invoke("flowstoken:account:logout"),
			ensureKeys: (groupIds) => ipc.invoke("flowstoken:account:ensure-keys", groupIds),
			refresh: () => ipc.invoke("flowstoken:account:refresh"),
			openExternal: (url) => ipc.invoke("flowstoken:account:open-external", url),
			getCatalog: (options) => ipc.invoke("flowstoken:catalog:get", options),
			getCatalogSnapshot: (options) => ipc.invoke("flowstoken:catalog:get-snapshot", options),
			onAccountChanged: (listener) => {
				const handler = (_event: unknown, snapshot: FlowstokenAccountSnapshot) => listener(snapshot);
				ipc.on("flowstoken:account:changed", handler);
				return () => {
					ipc.removeListener("flowstoken:account:changed", handler);
				};
			},
		},
	};
}
