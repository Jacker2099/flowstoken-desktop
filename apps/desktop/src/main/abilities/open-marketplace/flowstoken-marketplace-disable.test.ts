// FlowsToken: builds bake VETTA_DISABLE_BUILTIN_MARKETPLACE=1; the builtin Vetta marketplace must then
// stay off (supply-chain), while unflagged environments keep the upstream default.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceSourceStore } from "./marketplace-source-store";

const dirs: string[] = [];

async function storeFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ft-marketplace-"));
	dirs.push(dir);
	return join(dir, "sources.json");
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FlowsToken builtin marketplace switch", () => {
	it.each(["1", "true"])("registers no builtin source when VETTA_DISABLE_BUILTIN_MARKETPLACE=%s", async (flag) => {
		vi.stubEnv("VETTA_DISABLE_BUILTIN_MARKETPLACE", flag);
		for (const repository of [undefined, "", "example/market"]) {
			vi.stubEnv("VETTA_OPEN_MARKETPLACE_REPOSITORY", repository);
			expect(new MarketplaceSourceStore({ filePath: await storeFile() }).list()).toEqual([]);
		}
	});

	it("keeps the upstream official source when the flag is absent", async () => {
		vi.stubEnv("VETTA_DISABLE_BUILTIN_MARKETPLACE", undefined);
		vi.stubEnv("VETTA_OPEN_MARKETPLACE_REPOSITORY", "");
		expect(new MarketplaceSourceStore({ filePath: await storeFile() }).list()).toMatchObject([
			{ id: "vetta-official" },
		]);
	});
});
