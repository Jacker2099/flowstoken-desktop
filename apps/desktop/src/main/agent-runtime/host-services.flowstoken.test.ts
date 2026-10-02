import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStorage } from "@vetta/coding-agent/host-services";
import type { Session } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FlowstokenCatalog } from "../flowstoken/types.js";
import type { ModelsConfig } from "../models/model-settings-service.js";

const state = vi.hoisted(() => ({
	cacheDir: "",
	userId: 8,
	secret: "sk-fixture-B",
	allowed: { default: {} } as Record<string, object>,
	catalog: null as FlowstokenCatalog | null,
	config: { providers: {} } as ModelsConfig,
	values: new Map<string, string>(),
	session: {} as Record<string, unknown>,
	requests: [] as string[],
}));

vi.mock("electron", () => ({
	app: { getPath: () => state.cacheDir },
	BrowserWindow: vi.fn(),
	session: { fromPartition: () => state.session },
	net: { fetch: async () => Response.json(state.catalog) },
}));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("@vetta/coding-agent/config", () => ({ getAgentDir: () => "/fixture/flowstoken-host-test" }));
vi.mock("../models/model-settings-service.js", () => ({ readModelsConfigSync: () => state.config }));
vi.mock("../models/model-credential-store.js", () => ({
	getDesktopModelCredentialStore: () => ({
		get: (ref: string) => state.values.get(ref),
		has: (ref: string) => state.values.has(ref),
		isAvailable: () => true,
		set: (ref: string, key: string) => {
			state.values.set(ref, key);
		},
		remove: (ref: string) => {
			state.values.delete(ref);
		},
	}),
}));
vi.mock("@vetta/runtime-node/host", async (original) => ({
	...(await original<object>()),
	NodeTransactionalTextStorage: class {
		private content = "{}";
		withLock<T>(operation: (value: string) => { result: T; next?: string }): T {
			const result = operation(this.content);
			if (result.next !== undefined) this.content = result.next;
			return result.result;
		}
	},
	nodeSyncTextFileSource: { exists: () => true, read: () => JSON.stringify(state.config) },
}));

beforeEach(async () => {
	vi.resetModules();
	state.cacheDir = await mkdtemp(join(tmpdir(), "flowstoken-production-host-"));
	state.userId = 8;
	state.secret = "sk-fixture-B";
	state.allowed = { default: {} };
	state.requests = [];
	state.catalog = {
		schema: 2,
		revision: "active",
		generated: 1,
		pricingVersion: "test",
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: [
			{
				id: "default",
				providerId: "flowstoken-default",
				title: "Default",
				subtitle: "",
				vendors: [
					{
						id: "openai",
						name: "OpenAI",
						icon: null,
						mono: false,
						models: [
							{
								id: "gpt-fixture",
								name: "Fixture",
								kind: "chat",
								released: null,
								tags: [],
								vision: false,
								image: false,
							},
						],
					},
				],
			},
		],
	};
	state.config = {
		providers: Object.fromEntries(
			["flowstoken-default", "flowstoken-normal"].map((provider) => [
				provider,
				{
					api: "openai-completions",
					baseUrl: "https://www.flowstoken.com/v1",
					credentialRef: provider,
					managedGroup: { source: "flowstoken", accountId: 8, groupId: "default", tokenId: 10 },
					models: [{ id: "gpt-fixture", name: "Fixture", input: ["text"] }],
				},
			]),
		),
	};
	state.values = new Map([
		["flowstoken-default", state.secret],
		["flowstoken-normal", "sk-fixture-A"],
	]);
	state.session = {
		cookies: { get: async () => [] },
		fetch: async (url: string) => {
			const path = new URL(url).pathname;
			state.requests.push(path);
			const data =
				path === "/api/user/auth/refresh"
					? { access_token: "fixture-access", user: { id: state.userId } }
					: path === "/api/user/self/groups"
						? state.allowed
						: path === "/api/token/"
							? { items: [{ id: 10, name: "FlowsToken-Desktop-普通", group: "default", status: 1 }] }
							: path === "/api/token/10/key"
								? { key: state.secret }
								: null;
			if (data === null) throw new Error(`Unexpected request ${path}`);
			return Response.json({ success: true, data });
		},
	};
	const client = await import("../flowstoken/newapi-client.js");
	await client.refreshAuth(state.session as unknown as Session);
});
afterEach(async () => {
	await rm(state.cacheDir, { recursive: true, force: true });
});

it("production assembly blocks a cached model retired by the catalog", async () => {
	const host = await import("./host-services.js");
	const runtime = host.getOrCreateSharedModelRuntime();
	const saved = runtime.find("flowstoken-default", "gpt-fixture")!;
	expect(await runtime.getApiKey(saved)).toBe(state.secret);
	state.catalog = { ...state.catalog!, revision: "removed", groups: [] };
	await (await import("../flowstoken/group-catalog.js")).getCatalog({ force: true });
	await expect(runtime.getApiKey(saved)).rejects.toMatchObject({
		code: "FLOWSTOKEN_GROUP_UNAVAILABLE",
		modelKey: "flowstoken-default/gpt-fixture",
	});
});

it("does not return normal/A credentials when its editable ledger claims canonical default/B ownership", async () => {
	const runtime = (await import("./host-services.js")).getOrCreateSharedModelRuntime();
	expect(await runtime.getApiKey(runtime.find("flowstoken-default", "gpt-fixture")!)).toBe(state.secret);
	await expect(runtime.getApiKey(runtime.find("flowstoken-normal", "gpt-fixture")!)).rejects.toMatchObject({
		code: "FLOWSTOKEN_CREDENTIAL_STALE",
		modelKey: "flowstoken-normal/gpt-fixture",
	});
});

it("rejects the old actual key during same-account token rotation and accepts the synchronized replacement", async () => {
	const host = await import("./host-services.js");
	const runtime = host.getOrCreateSharedModelRuntime();
	const saved = runtime.find("flowstoken-default", "gpt-fixture")!;
	expect(await runtime.getApiKey(saved)).toBe(state.secret);
	state.secret = "sk-fixture-rotated";
	const client = await import("../flowstoken/newapi-client.js");
	const verified = await client.revealTokenKey(state.session as unknown as Session, 10);
	(await import("../flowstoken/catalog-access.js")).rememberVerifiedGroupKey(
		"default",
		8,
		10,
		verified,
		client.getFlowstokenAuthRevision(),
	);
	await expect(runtime.getApiKey(saved)).rejects.toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	state.values.set("flowstoken-default", verified);
	host.syncSharedModelRuntimeCredentials(
		(await import("../models/model-credential-store.js")).getDesktopModelCredentialStore(),
		state.config.providers,
	);
	expect(await runtime.getApiKey(saved)).toBe(verified);
});

it("does not finish an admitted old-key lookup after same-user rotation during credential resolution", async () => {
	const host = await import("./host-services.js");
	const runtime = host.getOrCreateSharedModelRuntime();
	const saved = runtime.find("flowstoken-default", "gpt-fixture")!;
	await runtime.getApiKey(saved);
	const { AuthStorage: Auth } = await import("@vetta/coding-agent/host-services");
	const original = Auth.prototype.getApiKey;
	let started!: () => void;
	let finish!: () => void;
	const reading = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const spy = vi.spyOn(Auth.prototype, "getApiKey").mockImplementation(async function (
		this: AuthStorage,
		provider: string,
	) {
		const key = await original.call(this, provider);
		started();
		await gate;
		return key;
	});
	try {
		const pending = runtime.getApiKey(saved).catch((error: unknown) => error);
		await reading;
		state.secret = "sk-fixture-new-generation";
		const client = await import("../flowstoken/newapi-client.js");
		const key = await client.revealTokenKey(state.session as unknown as Session, 10);
		(await import("../flowstoken/catalog-access.js")).rememberVerifiedGroupKey(
			"default",
			8,
			10,
			key,
			client.getFlowstokenAuthRevision(),
		);
		state.values.set("flowstoken-default", key);
		host.syncSharedModelRuntimeCredentials(
			(await import("../models/model-credential-store.js")).getDesktopModelCredentialStore(),
			state.config.providers,
		);
		finish();
		expect(await pending).toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	} finally {
		finish();
		spy.mockRestore();
	}
	expect(await runtime.getApiKey(saved)).toBe(state.secret);
});

it.each(["catalog", "permission"])(
	"rejects locally observed %s retirement during actual credential resolution",
	async (change) => {
		const runtime = (await import("./host-services.js")).getOrCreateSharedModelRuntime();
		const saved = runtime.find("flowstoken-default", "gpt-fixture")!;
		await runtime.getApiKey(saved);
		const { AuthStorage: Auth } = await import("@vetta/coding-agent/host-services");
		const original = Auth.prototype.getApiKey;
		let started!: () => void;
		let finish!: () => void;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const spy = vi.spyOn(Auth.prototype, "getApiKey").mockImplementation(async function (
			this: AuthStorage,
			provider: string,
		) {
			const key = await original.call(this, provider);
			started();
			await gate;
			return key;
		});
		try {
			const pending = runtime.getApiKey(saved).catch((error: unknown) => error);
			await reading;
			if (change === "catalog") {
				state.catalog = { ...state.catalog!, revision: "retired-during-checkout", groups: [] };
				await (await import("../flowstoken/group-catalog.js")).getCatalog({ force: true });
			} else {
				state.allowed = {};
				await (await import("../flowstoken/catalog-access.js")).getAuthenticatedCatalogAccess({ force: true });
			}
			finish();
			expect(await pending).toMatchObject({
				code: "FLOWSTOKEN_GROUP_UNAVAILABLE",
				modelKey: "flowstoken-default/gpt-fixture",
			});
		} finally {
			finish();
			spy.mockRestore();
		}
	},
);

it.each(["route", "auth-header"])(
	"checks the actual cached model %s before releasing account credentials",
	async (change) => {
		const provider = state.config.providers["flowstoken-default"];
		if (change === "route") provider.baseUrl = "https://fixture.invalid/v1";
		else provider.headers = { Authorization: "Bearer fixture-other-account" };
		const runtime = (await import("./host-services.js")).getOrCreateSharedModelRuntime();
		await expect(runtime.getApiKey(runtime.find("flowstoken-default", "gpt-fixture")!)).rejects.toMatchObject({
			code: "FLOWSTOKEN_CREDENTIAL_STALE",
		});
		expect(state.requests).not.toContain("/api/token/10/key");
	},
);

it.each(["image", "embedding", "rerank", "audio", "video"] as const)(
	"production chat lookup refuses %s catalog models",
	async (kind) => {
		state.catalog!.groups[0].vendors[0].models[0] = {
			...state.catalog!.groups[0].vendors[0].models[0],
			kind,
			image: kind === "image",
		};
		const runtime = (await import("./host-services.js")).getOrCreateSharedModelRuntime();
		await expect(runtime.getApiKey(runtime.find("flowstoken-default", "gpt-fixture")!)).rejects.toMatchObject({
			code: "FLOWSTOKEN_MODEL_UNAVAILABLE",
		});
		expect(state.requests).not.toContain("/api/token/10/key");
	},
);
