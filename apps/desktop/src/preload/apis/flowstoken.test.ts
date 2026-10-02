import { ipcRenderer } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import { createFlowstokenApi } from "./flowstoken.js";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

beforeEach(() => invoke.mockReset());

it("passes catalog force options through the legacy and paired IPC methods", async () => {
	const { flowstoken } = createFlowstokenApi(ipcRenderer);
	const catalog = { schema: 2, revision: "fixture", groups: [] };
	const snapshot = { catalog, config: { providers: {} } };
	invoke.mockResolvedValueOnce(catalog).mockResolvedValueOnce(snapshot);
	expect(await flowstoken.getCatalog({ force: true })).toBe(catalog);
	expect(invoke).toHaveBeenNthCalledWith(1, "flowstoken:catalog:get", { force: true });
	expect(await flowstoken.getCatalogSnapshot({ force: true })).toBe(snapshot);
	expect(invoke).toHaveBeenNthCalledWith(2, "flowstoken:catalog:get-snapshot", { force: true });
});
