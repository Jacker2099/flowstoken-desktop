// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { modelCatalog } from "./model-catalog";

afterEach(() => {
	vi.unstubAllEnvs();
	modelCatalog.reset();
});

it("never requests an unregistered cloud model IPC in a FlowsToken lite build", async () => {
	vi.stubEnv("VETTA_CLOUD_ENABLED", "false");
	const fetchRemote = vi.fn(async () => {
		throw new Error("No handler registered");
	});
	Object.defineProperty(window, "vetta", { configurable: true, value: { models: { fetchRemote } } });
	await modelCatalog.revalidate({ sources: ["remote"], force: true });
	expect(fetchRemote).not.toHaveBeenCalled();
});

it("retains remote catalog loading when cloud services are enabled", async () => {
	vi.stubEnv("VETTA_CLOUD_ENABLED", "true");
	const fetchRemote = vi.fn(async () => ({ providers: {} }));
	Object.defineProperty(window, "vetta", { configurable: true, value: { models: { fetchRemote } } });
	await modelCatalog.revalidate({ sources: ["remote"], force: true });
	expect(fetchRemote).toHaveBeenCalledOnce();
});
