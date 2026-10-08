import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialCryptography, CredentialVault } from "../credentials/credential-vault.js";
import type { ModelsConfig } from "../models/model-settings-service.js";
import type { NewApiTokenRow } from "./newapi-client.js";
import type { FlowstokenCatalog } from "./types.js";

const boundary = vi.hoisted(() => ({
	root: "",
	configPath: "",
	vault: undefined as CredentialVault | undefined,
	request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
	registryRefresh: vi.fn(),
	cryptoAvailable: vi.fn(),
	cryptoEncrypt: vi.fn(),
	cryptoDecrypt: vi.fn(),
	session: {
		fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
		cookies: { get: vi.fn(async () => []), flushStore: vi.fn(async () => {}) },
		clearStorageData: vi.fn(async () => {}),
	},
}));

vi.mock("electron", () => ({
	app: { getPath: () => boundary.root },
	BrowserWindow: vi.fn(),
	net: { fetch: (url: string, init?: RequestInit) => boundary.request(url, init) },
	session: { fromPartition: () => boundary.session },
	safeStorage: {
		isEncryptionAvailable: boundary.cryptoAvailable,
		encryptString: boundary.cryptoEncrypt,
		decryptString: boundary.cryptoDecrypt,
	},
}));
vi.mock("../credentials/desktop-credential-vault.js", () => ({
	getDesktopCredentialVault: () => {
		if (!boundary.vault) throw new Error("Isolated credential vault is not initialized");
		return boundary.vault;
	},
}));
// Keep the real service and host wiring, replacing only their filesystem location.
vi.mock("../models/model-settings-service.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readModelsConfig: async () => JSON.parse(readFileSync(boundary.configPath, "utf8")) as ModelsConfig,
	readModelsConfigSync: () => JSON.parse(readFileSync(boundary.configPath, "utf8")) as ModelsConfig,
	writeModelsConfig: async (config: ModelsConfig) => writeFileSync(boundary.configPath, JSON.stringify(config)),
}));
vi.mock("../agent-runtime/host-services.js", () => ({
	getOrCreateSharedModelRuntime: () => ({ refresh: boundary.registryRefresh }),
	syncSharedModelRuntimeCredentials: vi.fn(),
}));
vi.mock("../agent-teams/team-external-condition-channel.js", () => ({
	agentTeamExternalConditionChanges: { publish: vi.fn() },
}));
vi.mock("../proxy/proxy-host.js", () => ({ invalidateProxyProviderRouting: vi.fn() }));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));
vi.mock("../logger.js", () => ({ getAppLogger: () => ({ warn: vi.fn() }) }));

class FixtureCryptography implements CredentialCryptography {
	readonly backend = "isolated-keychain-fixture";
	available = true;
	readonly isAvailable = vi.fn(() => this.available);
	readonly encrypt = vi.fn((value: string) => {
		if (!this.available) throw new Error("fixture keychain denied");
		return Buffer.from(value).toString("base64");
	});
	readonly decrypt = vi.fn((value: string) => {
		const plain = Buffer.from(value, "base64").toString("utf8");
		if (!this.available || plain.startsWith("legacy-managed-")) throw new Error("fixture keychain denied");
		return plain;
	});
}

let crypto: FixtureCryptography;
let catalog: FlowstokenCatalog;
let tokens: NewApiTokenRow[];
let requests: Array<{ path: string; method: string }>;
let originalCiphertexts: Record<string, string>;
let originalCustomProviders: ModelsConfig["providers"];
let nextTokenId: number;
let assertNoVaultOperations: () => void;

function savedConfig(): ModelsConfig {
	return JSON.parse(readFileSync(boundary.configPath, "utf8")) as ModelsConfig;
}

function encryptedFiles(): Record<string, string> {
	const directory = join(boundary.root, "credentials");
	return Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")]));
}

function assertNoSecureStorageAccess(): void {
	assertNoVaultOperations();
	for (const call of [
		crypto.isAvailable,
		crypto.encrypt,
		crypto.decrypt,
		boundary.cryptoAvailable,
		boundary.cryptoEncrypt,
		boundary.cryptoDecrypt,
	])
		expect(call).not.toHaveBeenCalled();
	expect(encryptedFiles()).toEqual(originalCiphertexts);
	for (const [providerId, provider] of Object.entries(originalCustomProviders)) {
		expect(savedConfig().providers[providerId]).toEqual(provider);
	}
}

async function application() {
	const account = await import("./account-service.js");
	const client = await import("./newapi-client.js");
	const { getDesktopModelSettingsService } = await import("../models/model-settings-host.js");
	const { getFlowstokenSession } = await import("./login-window.js");
	const service = getDesktopModelSettingsService();
	await service.getRendererConfig();
	return {
		account,
		client,
		service,
		login: () =>
			client.loginWithPassword(getFlowstokenSession(), "fixture-user", "fixture-password", "fixture-turnstile"),
	};
}

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	boundary.root = mkdtempSync(join(tmpdir(), "flowstoken-credential-integration-"));
	boundary.configPath = join(boundary.root, "models.json");
	const { CredentialVault: Vault } = await import("../credentials/credential-vault.js");
	crypto = new FixtureCryptography();
	boundary.vault = new Vault(join(boundary.root, "credentials"), crypto);
	const { FLOWSTOKEN_GROUPS } = await import("./constants.js");
	const config: ModelsConfig = { defaultModel: "flowstoken-smart/Bestoo-Auto", providers: {} };
	boundary.vault.put(
		{ namespace: "models", ownerId: "existing-personal-ref", name: "api-key" },
		"fixture-existing-personal-key",
	);
	originalCustomProviders = {
		"existing-custom-encrypted": {
			baseUrl: "https://personal.fixture.invalid/v1",
			credentialRef: "existing-personal-ref",
			models: [{ id: "personal-model" }],
		},
		"existing-custom-legacy": {
			baseUrl: "https://legacy.fixture.invalid/v1",
			apiKey: "fixture-existing-legacy-plaintext",
			models: [{ id: "legacy-personal-model" }],
		},
	};
	Object.assign(config.providers, structuredClone(originalCustomProviders));
	tokens = [];
	catalog = {
		schema: 2,
		revision: "fixture-initial",
		generated: 1,
		pricingVersion: "fixture-pricing",
		newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: FLOWSTOKEN_GROUPS.map((group, index) => {
			const tokenId = index + 10;
			const credentialRef = `legacy-${group.id}`;
			boundary.vault?.put(
				{ namespace: "models", ownerId: credentialRef, name: "api-key" },
				`legacy-managed-${group.id}`,
			);
			config.providers[group.providerId] = {
				baseUrl: "https://www.flowstoken.com/v1",
				credentialRef,
				managedGroup: { source: "flowstoken", accountId: 7, groupId: group.id, tokenId },
				models: [{ id: group.id === "smart" ? "Bestoo-Auto" : "old-model" }],
			};
			tokens.push({ id: tokenId, name: group.tokenName, group: group.id, status: 1 });
			const modelId = group.id === "smart" ? "Bestoo-Auto" : `${group.id}-model`;
			return {
				id: group.id,
				providerId: group.providerId,
				title: group.labelZh,
				subtitle: "",
				defaultModel: modelId,
				vendors: [
					{
						id: "fixture",
						name: "Fixture",
						icon: null,
						mono: false,
						models: [
							{
								id: modelId,
								name: modelId,
								released: null,
								tags: [],
								vision: false,
								image: false,
								kind: "chat",
							},
						],
					},
				],
			};
		}),
	};
	writeFileSync(boundary.configPath, JSON.stringify(config));
	originalCiphertexts = encryptedFiles();
	crypto.available = false;
	crypto.isAvailable.mockClear();
	crypto.encrypt.mockClear();
	crypto.decrypt.mockClear();
	const vaultReads = vi.spyOn(boundary.vault, "get");
	const vaultWrites = vi.spyOn(boundary.vault, "put");
	const vaultRemovals = vi.spyOn(boundary.vault, "remove");
	assertNoVaultOperations = () => {
		expect(vaultReads).not.toHaveBeenCalled();
		expect(vaultWrites).not.toHaveBeenCalled();
		expect(vaultRemovals).not.toHaveBeenCalled();
	};
	requests = [];
	nextTokenId = 50;
	boundary.request.mockImplementation(async (url, init = {}) => {
		const path = new URL(url).pathname;
		const method = init.method ?? "GET";
		requests.push({ path, method });
		if (path === "/brand/desktop-catalog-v2.json") return Response.json(catalog);
		let data: unknown;
		const user = { id: 7, username: "fixture-user", group: "default", quota: 500_000, used_quota: 0 };
		if (path === "/api/user/login" || path === "/api/user/auth/refresh")
			data = { access_token: "fixture-access", user };
		else if (path === "/api/user/self") data = user;
		else if (path === "/api/user/self/groups") data = { smart: {}, default: {}, vip: {} };
		else if (path === "/api/token/" && method === "POST") {
			const input = JSON.parse(String(init.body)) as { group: string; name: string };
			tokens.push({ ...input, id: nextTokenId++, status: 1 });
			data = {};
		} else if (path === "/api/token/") data = { items: tokens };
		else if (/^\/api\/token\/\d+\/key$/.test(path)) data = { key: `fixture-session-key-${path.split("/")[3]}` };
		else if (path === "/api/log/self") data = { items: [] };
		else throw new Error(`Unexpected fixture request: ${method} ${path}`);
		return Response.json({ success: true, data });
	});
	boundary.session.fetch.mockImplementation((url, init) => boundary.request(url, init));
});

afterEach(() => {
	rmSync(boundary.root, { recursive: true, force: true });
	boundary.vault = undefined;
});

describe("account provisioning with real session credential storage", () => {
	it("returns a signed-out snapshot even offline without probing the cleared session again", async () => {
		const { account, login } = await application();
		await login();
		const requestsBeforeLogout = boundary.session.fetch.mock.calls.length;
		boundary.session.fetch.mockRejectedValue(new TypeError("fetch failed"));
		await expect(account.logoutAccount()).resolves.toMatchObject({ loggedIn: false, user: null, groups: [] });
		expect(boundary.session.fetch).toHaveBeenCalledTimes(requestsBeforeLogout);
		expect(boundary.session.clearStorageData).toHaveBeenCalled();
	});
	it("reads startup and account snapshots in a mixed configuration without opening or migrating custom credentials", async () => {
		const { account, service, login } = await application();
		const renderer = await service.getRendererConfig();
		expect(renderer.providers["existing-custom-encrypted"].apiKey).toBe("***");
		expect(renderer.providers["existing-custom-legacy"].apiKey).toBe("***");
		expect((await service.list()).providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "existing-custom-encrypted", hasApiKey: true }),
				expect.objectContaining({ id: "existing-custom-legacy", hasApiKey: true }),
			]),
		);
		const sanitized = await service.getSanitizedConfig();
		expect(JSON.stringify(sanitized)).not.toContain("fixture-existing-legacy-plaintext");
		await service.getSanitizedProvider("existing-custom-encrypted");
		await service.validateModelKey("flowstoken-smart/Bestoo-Auto");
		assertNoSecureStorageAccess();
		await login();
		const snapshot = await account.getAccountSnapshot({ includeUsage: false });
		expect(snapshot).toMatchObject({ loggedIn: true, user: { id: 7 } });
		await account.getCatalogSnapshot();
		assertNoSecureStorageAccess();
	});
	it("logs in, wires all groups and returns paired metadata without opening the denied keychain", async () => {
		const { account, service, login } = await application();
		assertNoSecureStorageAccess();
		await login();
		const result = await account.ensureGroupKeysAndProviders();
		expect(result.ok).toBe(true);
		expect(result.snapshot).toMatchObject({ loggedIn: true, user: { id: 7 } });
		expect(result.snapshot?.groups).toHaveLength(3);
		expect(result.snapshot?.groups.every((group) => group.enabled && group.wired)).toBe(true);
		const snapshot = await account.getCatalogSnapshot({ force: true });
		for (const group of snapshot.catalog.groups) {
			expect(snapshot.config.providers[group.providerId].apiKey).toBe("***");
			expect(savedConfig().providers[group.providerId].apiKey).toBeUndefined();
			expect(savedConfig().providers[group.providerId].credentialRef).toBe(`legacy-${group.id}`);
			expect(await service.getProviderApiKey(group.providerId)).toMatch(/^sk-fixture-session-key-/);
		}
		expect(JSON.stringify(savedConfig())).not.toContain("fixture-session-key-");
		expect(requests.filter((request) => /\/api\/token\/\d+\/key$/.test(request.path))).toHaveLength(3);
		assertNoSecureStorageAccess();
	});

	it("creates missing remote group tokens without creating or replacing local encrypted credentials", async () => {
		tokens = [];
		const { account, login } = await application();
		await login();
		const result = await account.ensureGroupKeysAndProviders();
		expect(result.ok).toBe(true);
		expect(result.created).toHaveLength(3);
		expect(result.snapshot?.groups.every((group) => group.wired)).toBe(true);
		expect(tokens).toHaveLength(3);
		assertNoSecureStorageAccess();
	});

	it("refreshes catalog models while preserving session wiring, user selection and old cipher bytes", async () => {
		const { account, login } = await application();
		await login();
		expect((await account.ensureGroupKeysAndProviders()).ok).toBe(true);
		const defaultModel = savedConfig().defaultModel;
		const reads = requests.filter((request) => request.path.endsWith("/key")).length;
		catalog = structuredClone(catalog);
		catalog.revision = "fixture-model-refresh";
		const group = catalog.groups.find((entry) => entry.id === "default");
		if (!group) throw new Error("Default fixture group is missing");
		group.vendors[0].models[0].id = "replacement-model";
		group.defaultModel = "replacement-model";
		const snapshot = await account.getCatalogSnapshot({ force: true });
		expect(snapshot.catalog.revision).toBe("fixture-model-refresh");
		expect(snapshot.config.providers["flowstoken-default"].models?.map((model) => model.id)).toEqual([
			"replacement-model",
		]);
		expect(savedConfig().defaultModel).toBe(defaultModel);
		expect((await account.getAccountSnapshot({ includeUsage: false })).groups.every((entry) => entry.wired)).toBe(
			true,
		);
		expect(requests.filter((request) => request.path.endsWith("/key"))).toHaveLength(reads);
		expect(JSON.stringify(savedConfig())).not.toContain("fixture-session-key-");
		assertNoSecureStorageAccess();
	});

	it("restarts with metadata only and reacquires session keys after login without probing the old vault", async () => {
		const first = await application();
		await first.login();
		expect((await first.account.ensureGroupKeysAndProviders()).ok).toBe(true);
		vi.resetModules();
		const restarted = await application();
		expect(restarted.client.getFlowstokenAccountId()).toBeNull();
		expect((await restarted.service.getRendererConfig()).providers["flowstoken-default"].apiKey).toBeUndefined();
		await expect(restarted.service.getProviderApiKey("flowstoken-default")).resolves.toBeUndefined();
		assertNoSecureStorageAccess();
		await restarted.login();
		expect(
			(await restarted.account.ensureGroupKeysAndProviders()).snapshot?.groups.every((group) => group.wired),
		).toBe(true);
		assertNoSecureStorageAccess();
	});

	it("keeps a manual override and an ordinary custom key persistent without reading or replacing legacy managed ciphertext", async () => {
		const { account, service, login } = await application();
		await login();
		expect((await account.ensureGroupKeysAndProviders()).ok).toBe(true);
		assertNoSecureStorageAccess();
		crypto.available = true; // Only the explicit personal-key operation is allowed to use the fixture keychain.
		const renderer = await service.getRendererConfig();
		renderer.providers["flowstoken-default"].apiKey = "fixture-personal-override";
		renderer.providers.personal = { apiKey: "fixture-custom-key", models: [{ id: "personal-model" }] };
		await service.replaceConfig(renderer);
		expect(savedConfig().providers["flowstoken-default"].managedGroupOverride).toBe(true);
		expect(savedConfig().providers["flowstoken-default"].credentialRef).not.toBe("legacy-default");
		expect(crypto.encrypt).toHaveBeenCalledWith("fixture-personal-override");
		expect(crypto.encrypt).toHaveBeenCalledWith("fixture-custom-key");
		const encryptedAfterSave = encryptedFiles();
		const cryptoAfterSave = [crypto.isAvailable, crypto.encrypt, crypto.decrypt].map(
			(call) => call.mock.calls.length,
		);
		expect((await account.ensureGroupKeysAndProviders()).ok).toBe(true);
		await account.getCatalogSnapshot({ force: true });
		expect([crypto.isAvailable, crypto.encrypt, crypto.decrypt].map((call) => call.mock.calls.length)).toEqual(
			cryptoAfterSave,
		);
		expect(encryptedFiles()).toEqual(encryptedAfterSave);
		await expect(service.getProviderApiKey("flowstoken-default")).resolves.toBe("fixture-personal-override");
		await expect(service.getProviderApiKey("personal")).resolves.toBe("fixture-custom-key");
		for (const [name, contents] of Object.entries(originalCiphertexts)) expect(encryptedFiles()[name]).toBe(contents);
		for (const [cipher] of crypto.decrypt.mock.calls)
			expect(Buffer.from(cipher, "base64").toString("utf8")).not.toMatch(/^legacy-managed-/);
		expect(JSON.stringify(savedConfig())).not.toContain("fixture-personal-override");
		expect(JSON.stringify(savedConfig())).not.toContain("fixture-custom-key");
	});
});
