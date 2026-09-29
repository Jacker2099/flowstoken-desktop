import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	diskDir: "",
}));

vi.mock("electron", () => ({
	net: { fetch: mocks.fetch },
	app: { getPath: () => mocks.diskDir },
}));

const {
	catalogGroupModels,
	fetchCatalog,
	fallbackCatalog,
	fallbackGroupModels,
	getCatalog,
	parseCatalog,
	resetGroupCatalogCacheForTests,
	setCatalogDiskPathForTests,
} = await import("./group-catalog.js");

const catalogFixture = {
	schema: 1,
	generated: 1790000000,
	pricingVersion: "pv-test-1",
	newWindowDays: 30,
	iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
	groups: [
		{
			id: "smart",
			providerId: "flowstoken-smart",
			title: "智能组",
			subtitle: "一个模型，自动调度顶尖模型",
			defaultModel: "Bestoo-Auto",
			highlight: { title: "Bestoo-Auto（智能选模）", badge: "推荐", description: "自动调度" },
			vendors: [
				{
					id: "bestoo",
					name: "Bestoo AI",
					icon: null,
					mono: false,
					models: [
						{ id: "Bestoo-Auto", name: "Bestoo-Auto", released: null, tags: [], vision: true, image: false },
					],
				},
			],
		},
		{
			id: "default",
			providerId: "flowstoken-default",
			title: "普通组",
			subtitle: "",
			vendors: [
				{
					id: "anthropic",
					name: "Anthropic",
					icon: "claude-color.svg",
					mono: false,
					models: [
						{
							id: "claude-opus-5-5",
							name: "Claude Opus 5.5",
							released: 1790000000,
							tags: [],
							vision: true,
							image: false,
						},
						{
							id: "claude-sonnet-5-5",
							name: "Claude Sonnet 5.5",
							released: 1790000000,
							tags: [],
							vision: true,
							image: false,
						},
					],
				},
				{
					id: "openai",
					name: "OpenAI",
					icon: "openai.svg",
					mono: true,
					models: [
						{ id: "gpt-6-sol", name: "GPT-6 Sol", released: 1790000000, tags: [], vision: true, image: false },
					],
				},
			],
		},
		{
			id: "vip",
			providerId: "flowstoken-official",
			title: "官方组",
			subtitle: "",
			vendors: [
				{
					id: "anthropic",
					name: "Anthropic",
					icon: "claude-color.svg",
					mono: false,
					models: [
						{
							id: "anthropic/claude-opus-5.5",
							name: "Claude Opus 5.5",
							released: 1790000000,
							tags: ["官方模型"],
							vision: true,
							image: false,
						},
					],
				},
			],
		},
	],
};

function respond(body: unknown) {
	mocks.fetch.mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(() => {
	vi.clearAllMocks();
	resetGroupCatalogCacheForTests();
	mocks.diskDir = mkdtempSync(join(tmpdir(), "ft-catalog-"));
	setCatalogDiskPathForTests(join(mocks.diskDir, "flowstoken", "desktop-catalog.json"));
});

afterEach(() => {
	setCatalogDiskPathForTests(null);
	rmSync(mocks.diskDir, { recursive: true, force: true });
});

describe("desktop catalog fetch", () => {
	it("returns the server catalog with ordered models and display names", async () => {
		respond(catalogFixture);
		const catalog = await fetchCatalog();
		expect(catalog?.pricingVersion).toBe("pv-test-1");
		expect(catalog?.groups.map((g) => g.id)).toEqual(["smart", "default", "vip"]);

		const defaults = catalogGroupModels(catalog!, "default");
		expect(defaults.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-sol"]);
		expect(defaults[0].name).toBe("Claude Opus 5.5");
		expect(catalog!.groups[0].defaultModel).toBe("Bestoo-Auto");

		// Successful fetch atomically lands on disk for offline runs.
		const disk = JSON.parse(readFileSync(join(mocks.diskDir, "flowstoken", "desktop-catalog.json"), "utf8"));
		expect(disk.pricingVersion).toBe("pv-test-1");
	});

	it("uses the in-memory TTL for repeat fetches", async () => {
		respond(catalogFixture);
		const now = Date.now();
		await fetchCatalog(now);
		await fetchCatalog(now + 60_000);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
	});

	it("falls back to the disk cache when the schema is invalid", async () => {
		respond(catalogFixture);
		await fetchCatalog();
		resetGroupCatalogCacheForTests();

		respond({ schema: 2, groups: [] });
		const catalog = await fetchCatalog(Date.now() + 11 * 60 * 1000);
		expect(catalog?.pricingVersion).toBe("pv-test-1");
	});

	it("falls back to the disk cache when the network fails", async () => {
		respond(catalogFixture);
		await fetchCatalog();
		resetGroupCatalogCacheForTests();

		mocks.fetch.mockRejectedValue(new Error("offline"));
		const catalog = await fetchCatalog(Date.now() + 11 * 60 * 1000);
		expect(catalog?.groups.find((g) => g.id === "vip")?.providerId).toBe("flowstoken-official");
	});

	it("returns the static fallback when neither network nor disk is available", async () => {
		mocks.fetch.mockRejectedValue(new Error("offline"));
		const catalog = await getCatalog();
		expect(catalog.pricingVersion).toBe("");
		const defaults = catalogGroupModels(catalog, "default");
		expect(defaults.length).toBeGreaterThan(0);
		expect(defaults[0].name).toBe(defaults[0].id.slice(defaults[0].id.indexOf("/") + 1));
		expect(catalogGroupModels(catalog, "smart")[0]?.id).toBe("Bestoo-Auto");
	});

	it("parses schema 1 strictly: rejects malformed groups/vendors/models", () => {
		expect(parseCatalog({ schema: 1, groups: "nope" })).toBeNull();
		expect(parseCatalog({ schema: 1, groups: [{ id: "vip" }] })).toBeNull();
		expect(
			parseCatalog({
				schema: 1,
				groups: [
					{
						id: "vip",
						providerId: "flowstoken-official",
						title: "官方组",
						vendors: [{ id: "a", name: "A", models: [{ id: "x" }] }],
					},
				],
			}),
		).toBeNull();
		expect(parseCatalog(catalogFixture)?.groups).toHaveLength(3);
	});
});

describe("fallback catalog", () => {
	it("exposes the smart default and strips vendor prefixes from names", () => {
		const catalog = fallbackCatalog();
		expect(catalog.groups.find((g) => g.id === "smart")?.defaultModel).toBe("Bestoo-Auto");
		const vip = fallbackGroupModels("vip");
		expect(vip.length).toBeGreaterThan(0);
		for (const m of vip) expect(m.name.includes("/")).toBe(false);
	});
});
