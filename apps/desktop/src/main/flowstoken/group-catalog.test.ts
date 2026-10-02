import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowstokenCatalog } from "./types.js";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	diskDir: "",
}));

vi.mock("electron", () => ({
	net: { fetch: mocks.fetch },
	app: { getPath: () => mocks.diskDir },
}));

const {
	CATALOG_CACHE_MS,
	CATALOG_V1_URL,
	CATALOG_V2_URL,
	catalogGroupModels,
	fetchCatalog,
	fallbackCatalog,
	fallbackGroupModels,
	getCatalog,
	isValidBillingGroupId,
	isManagedFlowstokenProviderId,
	parseCatalog,
	peekCachedCatalog,
	providerIdForGroup,
	resetGroupCatalogCacheForTests,
	setCatalogDiskPathForTests,
} = await import("./group-catalog.js");

const catalogFixture: FlowstokenCatalog = {
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
	mocks.fetch.mockImplementation(async (url: string) => {
		if (url === CATALOG_V2_URL && (body as { schema?: unknown })?.schema === 1) return { ok: false, status: 404 };
		return { ok: true, status: 200, json: async () => body };
	});
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
		await fetchCatalog(now + CATALOG_CACHE_MS - 1);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("shares a cold catalog request across simultaneous account and picker refreshes", async () => {
		respond(catalogFixture);
		const [account, picker] = await Promise.all([fetchCatalog(), fetchCatalog()]);
		expect(account).toEqual(picker);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("refuses catalogs that relabel another billing provider or repeat a group", () => {
		const mislabeled = structuredClone(catalogFixture);
		mislabeled.groups[1].providerId = "flowstoken-official";
		expect(parseCatalog(mislabeled)).toBeNull();
		const repeated = structuredClone(catalogFixture);
		repeated.groups.push(repeated.groups[1]);
		expect(parseCatalog(repeated)).toBeNull();
	});

	it("keeps the first model occurrence in server order within each billing group", () => {
		const repeated = structuredClone(catalogFixture);
		repeated.groups[1].vendors[0].models.push(repeated.groups[1].vendors[0].models[0]);
		repeated.groups[1].vendors[1].models.unshift(repeated.groups[1].vendors[0].models[0]);
		const catalog = parseCatalog(repeated)!;
		expect(catalogGroupModels(catalog, "default").map((m) => m.id)).toEqual([
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"gpt-6-sol",
		]);
		expect(catalog.groups[1].vendors[1].models.map((m) => m.id)).toEqual(["gpt-6-sol"]);
		expect(catalogGroupModels(catalog, "vip")).toHaveLength(1);
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
	it("marks the exact known image-generation model so offline chat consumers can exclude it", () => {
		const model = fallbackGroupModels("default").find((entry) => entry.id === "gpt-image-2");
		expect(model).toMatchObject({ id: "gpt-image-2", image: true, vision: false });
		expect(
			fallbackGroupModels("default")
				.filter((entry) => !entry.image)
				.some((entry) => entry.id === "gpt-image-2"),
		).toBe(false);
		expect(fallbackGroupModels("smart")[0]).toMatchObject({ id: "Bestoo-Auto", image: false });
	});
	it("exposes the smart default and strips vendor prefixes from names", () => {
		const catalog = fallbackCatalog();
		expect(catalog.groups.find((g) => g.id === "smart")?.defaultModel).toBe("Bestoo-Auto");
		const vip = fallbackGroupModels("vip");
		expect(vip.length).toBeGreaterThan(0);
		for (const m of vip) expect(m.name.includes("/")).toBe(false);
	});
});

function v2Fixture(revision = "revision-2") {
	return { ...structuredClone(catalogFixture), schema: 2 as const, revision };
}

describe("schema-2 remote directory", () => {
	it("exposes only the locally observed complete catalog for synchronous request lease checks", async () => {
		expect(peekCachedCatalog()).toBeNull();
		expect(mocks.fetch).not.toHaveBeenCalled();
		respond(v2Fixture("observed"));
		const loaded = await fetchCatalog();
		expect(peekCachedCatalog()).toBe(loaded);
		const calls = mocks.fetch.mock.calls.length;
		expect(peekCachedCatalog()?.revision).toBe("observed");
		expect(mocks.fetch).toHaveBeenCalledTimes(calls);
		respond({ ...v2Fixture("retired"), groups: [] });
		await fetchCatalog(Date.now(), { force: true });
		expect(peekCachedCatalog()?.groups).toEqual([]);
		respond({ schema: 2, revision: "invalid", groups: [{ id: "vip" }] });
		await fetchCatalog(Date.now(), { force: true });
		expect(peekCachedCatalog()?.revision).toBe("retired");
		expect(peekCachedCatalog()?.groups).toEqual([]);
		resetGroupCatalogCacheForTests();
		expect(peekCachedCatalog()).toBeNull();
	});

	it("adds, renames, reorders and removes billing groups while provider identities stay fixed", async () => {
		const first = v2Fixture();
		const group = {
			...structuredClone(first.groups[1]),
			id: "Team.A-1",
			providerId: providerIdForGroup("Team.A-1"),
			title: "团队组",
		};
		first.groups.unshift(group);
		respond(first);
		const loaded = await fetchCatalog();
		expect(loaded?.groups[0]).toMatchObject({
			id: "Team.A-1",
			providerId: "flowstoken-group-Team.A-1",
			title: "团队组",
		});
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const second = v2Fixture("revision-3");
		second.groups = [first.groups[3], { ...group, title: "团队精选", vendors: [] }];
		respond(second);
		const changed = await fetchCatalog(Date.now(), { force: true });
		expect(changed?.groups.map((entry) => entry.id)).toEqual(["vip", "Team.A-1"]);
		expect(changed?.groups[1].providerId).toBe(loaded?.groups[0].providerId);
		expect(changed?.groups[1].title).toBe("团队精选");
		expect(catalogGroupModels(changed!, "Team.A-1")).toEqual([]);
		expect(fallbackGroupModels("Team.A-1")).toEqual([]);
	});

	it("supports capability and recommendation changes plus intentional removal of every group", () => {
		const body = v2Fixture();
		const model = body.groups[1].vendors[0].models[0];
		Object.assign(model, { recommended: true, reasoning: true, contextWindow: 128_000, maxTokens: 16_000 });
		body.groups[1].defaultModel = model.id;
		const parsed = parseCatalog(body)!;
		expect(catalogGroupModels(parsed, "default")[0]).toMatchObject({
			recommended: true,
			reasoning: true,
			contextWindow: 128_000,
			maxTokens: 16_000,
		});
		expect(parseCatalog({ ...body, groups: [] })?.groups).toEqual([]);
		expect(parseCatalog({ ...body, schema: 1, groups: [] })).toBeNull();
		body.groups[1].vendors = [];
		expect(parseCatalog(body)).toBeNull();
		delete body.groups[1].defaultModel;
		expect(parseCatalog(body)?.groups[1].vendors).toEqual([]);
	});
	it("keeps non-chat purposes out of chat projections and validates explicit supported reasoning levels", async () => {
		const body = v2Fixture();
		const base = body.groups[1].vendors[0].models[0];
		body.groups[1].vendors = [
			{
				id: "purposes",
				name: "Capabilities",
				icon: null,
				mono: false,
				models: [
					{
						...base,
						id: "chat-model",
						kind: "chat",
						reasoning: true,
						reasoningLevels: ["none", "low", "max"],
						defaultReasoningLevel: "low",
					},
					{ ...base, id: "image-model", kind: "image", image: true },
					{ ...base, id: "embedding-model", kind: "embedding" },
					{ ...base, id: "rerank-model", kind: "rerank" },
					{ ...base, id: "audio-model", kind: "audio" },
					{ ...base, id: "video-model", kind: "video" },
				],
			},
		];
		respond(body);
		const parsed = await fetchCatalog();
		const models = catalogGroupModels(parsed!, "default");
		expect(models.filter((model) => model.kind === "chat").map((model) => model.id)).toEqual(["chat-model"]);
		expect(models[0]).toMatchObject({ reasoningLevels: ["none", "low", "max"], defaultReasoningLevel: "low" });
		expect(models[1]).toMatchObject({ kind: "image", image: true });
		for (const invalid of [
			{ kind: "unknown-purpose" },
			{ kind: "image", image: false },
			{ kind: "chat", image: true },
			{ reasoningLevels: ["ultra"] },
			{ reasoningLevels: ["low", "low"] },
			{ reasoningLevels: ["low"], defaultReasoningLevel: "max" },
		]) {
			const update = structuredClone(body);
			Object.assign(update.groups[1].vendors[0].models[0], invalid);
			respond(update);
			const kept = await fetchCatalog(Date.now(), { force: true });
			expect(kept).toEqual({ ...parsed, source: "cache" });
		}
		const withoutDefault = { ...base, reasoningLevels: [] };
		const disabled = v2Fixture();
		disabled.groups[1].vendors[0].models = [withoutDefault];
		expect(catalogGroupModels(parseCatalog(disabled)!, "default")[0].reasoningLevels).toEqual([]);
	});

	it("rejects provider and billing aliases, executable configuration, unsafe IDs and duplicate groups/vendors atomically", () => {
		for (const mutate of [
			(body: ReturnType<typeof v2Fixture>) => {
				body.groups[1].providerId = "flowstoken-official";
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1], { accountGroup: "vip" });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1], { baseUrl: "https://untrusted.invalid/v1" });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1].vendors[0].models[0], { script: "arbitrary()" });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				body.groups[1].id = "bad/group";
			},
			(body: ReturnType<typeof v2Fixture>) => {
				body.groups.push(body.groups[1]);
			},
			(body: ReturnType<typeof v2Fixture>) => {
				body.groups[1].vendors.push(body.groups[1].vendors[0]);
			},
		]) {
			const body = v2Fixture();
			mutate(body);
			expect(parseCatalog(body)).toBeNull();
		}
		for (const id of ["", "a".repeat(65), "__proto__", "../vip", "vip\n", " VIP", "中文"])
			expect(isValidBillingGroupId(id)).toBe(false);
		expect(providerIdForGroup("VIP")).toBe("flowstoken-group-VIP");
		expect(providerIdForGroup("vip")).toBe("flowstoken-official");
		expect(providerIdForGroup("normal")).toBe("flowstoken-group-normal");
	});

	it("falls back to the legacy URL only on an explicit v2 404", async () => {
		respond(catalogFixture);
		const legacy = await fetchCatalog();
		expect(legacy?.schema).toBe(1);
		expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([CATALOG_V2_URL, CATALOG_V1_URL]);
		for (const status of [401, 403, 500]) {
			vi.clearAllMocks();
			resetGroupCatalogCacheForTests();
			mocks.fetch.mockResolvedValue({ ok: false, status });
			expect((await fetchCatalog())?.schema).toBe(1);
			expect(mocks.fetch).toHaveBeenCalledTimes(1);
		}
	});

	it("a malformed update preserves the last complete snapshot even if saving its disk cache failed", async () => {
		setCatalogDiskPathForTests(join(mocks.diskDir, "missing-parent", "..", "occupied"));
		const fs = await import("node:fs");
		fs.mkdirSync(join(mocks.diskDir, "occupied"));
		respond(v2Fixture("valid-before-failure"));
		const valid = await fetchCatalog();
		respond({ ...v2Fixture("invalid"), groups: [{ id: "other" }] });
		const kept = await fetchCatalog(Date.now() + CATALOG_CACHE_MS + 1);
		expect(kept).toEqual({ ...valid, source: "cache" });
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("coalesces forced reloads and accepts a deliberate rollback to an earlier opaque revision", async () => {
		respond(v2Fixture("r-new"));
		await fetchCatalog();
		const rollback = v2Fixture("r-old");
		rollback.groups = [rollback.groups[0]];
		respond(rollback);
		const [one, two] = await Promise.all([
			fetchCatalog(Date.now(), { force: true }),
			fetchCatalog(Date.now(), { force: true }),
		]);
		expect(one).toEqual(two);
		expect(one?.revision).toBe("r-old");
		expect(one?.groups).toHaveLength(1);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("loads a previous v2 snapshot offline after a cold cache reload", async () => {
		respond(v2Fixture());
		const live = await fetchCatalog();
		resetGroupCatalogCacheForTests();
		mocks.fetch.mockRejectedValue(new Error("offline"));
		expect(await getCatalog()).toEqual({ ...live, source: "cache" });
	});

	it("exposes localized titles and recognizes only canonical managed provider identities", () => {
		const body = v2Fixture();
		Object.assign(body.groups[1], { titles: { zh: "精选组", en: "Selected" } });
		expect(parseCatalog(body)?.groups[1].titles).toEqual({ zh: "精选组", en: "Selected" });
		for (const id of [
			"flowstoken-default",
			"flowstoken-normal",
			"flowstoken-smart",
			"flowstoken-official",
			"flowstoken-group-Team.A-1",
		])
			expect(isManagedFlowstokenProviderId(id)).toBe(true);
		for (const id of [
			"flowstoken-group-default",
			"flowstoken-group-vip",
			"flowstoken-group-../other",
			"custom-provider",
			"flowstoken-group-",
		])
			expect(isManagedFlowstokenProviderId(id)).toBe(false);
	});

	it("reports network, cache and fallback origins without accepting server-supplied freshness", async () => {
		respond({ ...v2Fixture(), fetchedAt: 1, source: "fallback" });
		const first = await fetchCatalog();
		expect(first?.source).toBe("network");
		expect(first!.fetchedAt).toBeGreaterThan(1);
		const cached = await fetchCatalog();
		expect(cached?.source).toBe("cache");
		expect(cached?.fetchedAt).toBe(first?.fetchedAt);
		expect(fallbackCatalog().source).toBe("fallback");
	});

	it("preserves the legacy cache while independently saving and reloading the v2 directory", async () => {
		setCatalogDiskPathForTests(null);
		respond(catalogFixture);
		await fetchCatalog();
		const legacyPath = join(mocks.diskDir, "flowstoken", "desktop-catalog.json");
		const original = readFileSync(legacyPath);
		respond(v2Fixture());
		await fetchCatalog(Date.now(), { force: true });
		expect(readFileSync(legacyPath)).toEqual(original);
		const v2Path = join(mocks.diskDir, "flowstoken", "desktop-catalog-v2.json");
		expect(JSON.parse(readFileSync(v2Path, "utf8")).schema).toBe(2);
		resetGroupCatalogCacheForTests();
		mocks.fetch.mockRejectedValue(new Error("offline"));
		expect((await getCatalog()).schema).toBe(2);
		rmSync(v2Path);
		resetGroupCatalogCacheForTests();
		expect((await getCatalog()).schema).toBe(1);
	});

	it("rejects malformed supported display and capability metadata instead of partially applying it", () => {
		for (const modify of [
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body, { newWindowDays: -1 });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body, { generated: "yesterday" });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1], { subtitle: 3 });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1], { titles: { zh: [] } });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1], { highlight: { title: "incomplete" } });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1].vendors[0].models[0], { reasoning: "true" });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				Object.assign(body.groups[1].vendors[0].models[0], { contextWindow: 100, maxTokens: 101 });
			},
			(body: ReturnType<typeof v2Fixture>) => {
				body.groups[1].vendors[0].icon = "../../secret.svg";
			},
		]) {
			const body = v2Fixture();
			modify(body);
			expect(parseCatalog(body)).toBeNull();
		}
	});
});
