import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsService, type ModelsConfig } from "../models/model-settings-service.js";

const boundary = vi.hoisted(() => ({
	fetch: vi.fn(),
	userData: "",
	authRevision: 0,
	service: undefined as ModelSettingsService | undefined,
}));

vi.mock("electron", () => ({ net: { fetch: boundary.fetch }, app: { getPath: () => boundary.userData } }));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("../models/model-settings-host.js", () => ({
	getDesktopModelSettingsService: () => {
		if (!boundary.service) throw new Error("Snapshot model fixture is not initialized");
		return boundary.service;
	},
}));
vi.mock("./login-window.js", () => ({
	getFlowstokenSessionProbeError: () => undefined,
	clearFlowstokenSession: vi.fn(),
	getFlowstokenSession: () => ({}),
	loginViaBrowserWindow: vi.fn(),
	loginWithPasswordAndTurnstile: vi.fn(),
	probeExistingSession: vi.fn(),
}));
vi.mock("./newapi-client.js", () => ({
	onFlowstokenAuthChanged: () => () => {},
	getCachedAccessToken: () => null,
	FlowstokenApiError: class extends Error {},
	createToken: vi.fn(),
	fetchSelf: vi.fn(),
	fetchSelfLogs: vi.fn(),
	findManagedToken: vi.fn(),
	getFlowstokenAccountId: () => null,
	getFlowstokenAuthRevision: () => boundary.authRevision,
	listTokens: vi.fn(),
	managedTokenName: vi.fn(),
	revealTokenKey: vi.fn(),
	refreshAuth: vi.fn(),
	fetchUsableGroups: vi.fn(),
}));

const { getCatalogAndRefreshProviders, getCatalogSnapshot } = await import("./account-service.js");
const { peekCachedCatalog, resetGroupCatalogCacheForTests } = await import("./group-catalog.js");

function catalog(revision: string) {
	return {
		schema: 2,
		revision,
		generated: 1,
		pricingVersion: "pricing",
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [
			{
				id: "default",
				title: "Normal",
				subtitle: "",
				defaultModel: `model-${revision}`,
				vendors: [
					{
						id: "openai",
						name: "OpenAI",
						icon: null,
						mono: false,
						models: [
							{ id: `model-${revision}`, name: revision, released: null, tags: [], vision: false, kind: "chat" },
						],
					},
				],
			},
		],
	};
}

let config: ModelsConfig;
let readCount: number;
let pausedRead: number | undefined;
let readStarted: () => void;
let readReleased: Promise<void>;
let releaseRead: () => void;

beforeEach(async () => {
	boundary.authRevision = 0;
	boundary.userData = await mkdtemp(join(tmpdir(), "flowstoken-catalog-snapshot-"));
	resetGroupCatalogCacheForTests();
	boundary.fetch.mockReset();
	boundary.fetch.mockResolvedValue(new Response(JSON.stringify(catalog("A"))));
	config = {
		defaultModel: "personal/custom",
		providers: {
			"flowstoken-default": {
				baseUrl: "https://www.flowstoken.com/v1",
				credentialRef: "managed-fixture",
				models: [{ id: "previous" }],
			},
			personal: {
				baseUrl: "https://byok.example/v1",
				credentialRef: "personal-fixture",
				headers: { Authorization: "Bearer fixture-personal-header", "X-Region": "us" },
				models: [{ id: "custom", maxTokens: 222 }],
			},
		},
	};
	const credentials = new Map([
		["managed-fixture", "fixture-managed-secret"],
		["personal-fixture", "fixture-personal-secret"],
	]);
	readCount = 0;
	pausedRead = undefined;
	boundary.service = new ModelSettingsService({
		readConfig: async () => {
			const snapshot = structuredClone(config);
			readCount += 1;
			if (readCount === pausedRead) {
				readStarted();
				await readReleased;
			}
			return snapshot;
		},
		writeConfig: async (next) => {
			config = structuredClone(next);
		},
		refreshRegistry: async () => {},
		credentials: {
			isAvailable: () => true,
			has: (id) => credentials.has(id),
			get: (id) => credentials.get(id),
			set: (id, key) => {
				credentials.set(id, key);
			},
			remove: (id) => {
				credentials.delete(id);
			},
		},
	});
	await boundary.service.getRendererConfig();
});

afterEach(async () => {
	resetGroupCatalogCacheForTests();
	await rm(boundary.userData, { recursive: true, force: true });
});

function pauseSnapshotRead(): Promise<void> {
	// The first queue read reconciles providers; the following read projects the paired snapshot.
	pausedRead = readCount + 2;
	readReleased = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	return new Promise<void>((resolve) => {
		readStarted = resolve;
	});
}

describe("Flowstoken paired catalog snapshots", () => {
	it("returns reconciled metadata and masked config while retaining personal BYOK and its default", async () => {
		const snapshot = await getCatalogSnapshot({ force: true });
		expect(snapshot.catalog.revision).toBe("A");
		expect(snapshot.config.providers["flowstoken-default"].models?.map((model) => model.id)).toEqual(["model-A"]);
		expect(snapshot.config.defaultModel).toBe("personal/custom");
		expect(snapshot.config.providers.personal).toMatchObject({
			baseUrl: "https://byok.example/v1",
			apiKey: "***",
			models: [{ id: "custom", maxTokens: 222 }],
		});
		expect(JSON.stringify(snapshot)).not.toContain("fixture-managed-secret");
		expect(JSON.stringify(snapshot)).not.toContain("fixture-personal-secret");
		expect(JSON.stringify(snapshot)).not.toContain("fixture-personal-header");
		if (!boundary.service) throw new Error("Snapshot model fixture is not initialized");
		await boundary.service.replaceConfig(snapshot.config);
		expect((await boundary.service.getConfig()).providers.personal.headers?.Authorization).toBe(
			"Bearer fixture-personal-header",
		);
	});

	it("retries when a newer catalog is observed during the queued config read", async () => {
		const reading = pauseSnapshotRead();
		const pending = getCatalogSnapshot({ force: true });
		await reading;
		boundary.fetch.mockResolvedValue(new Response(JSON.stringify(catalog("B"))));
		const refresh = getCatalogAndRefreshProviders({ force: true });
		await vi.waitFor(() => expect(peekCachedCatalog()?.revision).toBe("B"));
		releaseRead();
		const snapshot = await pending;
		await refresh;
		expect(snapshot.catalog.revision).toBe("B");
		expect(snapshot.config.providers["flowstoken-default"].models?.map((model) => model.id)).toEqual(["model-B"]);
		expect(snapshot.config.providers.personal.models).toEqual([{ id: "custom", maxTokens: 222 }]);
	});

	it("rejects a queued snapshot if the account changes while config is being read", async () => {
		const reading = pauseSnapshotRead();
		const pending = getCatalogSnapshot({ force: true });
		const rejected = expect(pending).rejects.toThrow("flowstoken.errors.accountChanged");
		await reading;
		boundary.authRevision += 1;
		releaseRead();
		await rejected;
	});
});
