import type { IpcRenderer, WebUtils } from "electron";
import { expect, it, vi } from "vitest";
import { createSystemApi } from "./system.js";

it("keeps ordinary model saves compatible and forwards the explicit rename context", async () => {
	const invoke = vi.fn(async () => undefined);
	const api = createSystemApi({ invoke } as unknown as IpcRenderer, {} as WebUtils).models;
	const config = { providers: {} };
	await api.set(config);
	await api.set(config, { renameProvider: { from: "old", to: "new" } });
	expect(invoke).toHaveBeenNthCalledWith(1, "vetta:models:set", config);
	expect(invoke).toHaveBeenNthCalledWith(2, "vetta:models:set", config, {
		renameProvider: { from: "old", to: "new" },
	});
});
