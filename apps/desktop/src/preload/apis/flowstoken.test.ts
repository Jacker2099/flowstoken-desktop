import type { IpcRenderer } from "electron";
import { expect, it, vi } from "vitest";
import { createFlowstokenApi } from "./flowstoken.js";

it("starts and cancels browser authorization without passing passwords or browser cookies", async () => {
	const invoke = vi.fn(async () => undefined);
	const api = createFlowstokenApi({ invoke } as unknown as IpcRenderer).flowstoken;
	await api.loginWithBrowser();
	await api.cancelLogin();
	expect(invoke.mock.calls).toEqual([["flowstoken:account:login-browser"], ["flowstoken:account:cancel-login"]]);
});
