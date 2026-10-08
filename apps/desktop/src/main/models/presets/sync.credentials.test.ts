import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialCryptography } from "../../credentials/credential-vault.js";
import type { ModelSettingsService, ModelsConfig } from "../model-settings-service.js";

const boundary = vi.hoisted(() => ({
	home: "",
	service: null as ModelSettingsService | null,
	fetch: vi.fn(),
}));

vi.mock("@vetta/action-rpc", () => ({ getVettaHomePath: () => boundary.home }));
vi.mock("electron", () => ({
	BrowserWindow: { getAllWindows: () => [] },
	net: { fetch: boundary.fetch },
	safeStorage: {},
}));
vi.mock("../../logger.js", () => ({ getAppLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock("../model-settings-host.js", () => ({ getDesktopModelSettingsService: () => boundary.service }));

class TestCryptography implements CredentialCryptography {
	readonly backend = "isolated-fixture";
	available = true;
	isAvailable = vi.fn(() => this.available);
	encrypt = vi.fn((value: string) => Buffer.from(value).toString("base64"));
	decrypt = vi.fn((value: string) => {
		if (!this.available) throw new Error("fixture keychain denied");
		return Buffer.from(value, "base64").toString("utf8");
	});
}

let cryptography: TestCryptography;
let config: ModelsConfig;
let writeConfig: ReturnType<typeof vi.fn>;
let credentialDirectory: string;

beforeEach(async () => {
	vi.resetModules();
	boundary.home = mkdtempSync(join(tmpdir(), "preset-credential-isolation-"));
	credentialDirectory = join(boundary.home, "credentials");
	const { CredentialVault } = await import("../../credentials/credential-vault.js");
	const { DesktopModelCredentialStore } = await import("../model-credential-store.js");
	const { ModelSettingsService } = await import("../model-settings-service.js");
	cryptography = new TestCryptography();
	const vault = new CredentialVault(credentialDirectory, cryptography);
	for (const ref of ["openai-key", "other-key"])
		vault.put({ namespace: "models", ownerId: ref, name: "api-key" }, `fixture-${ref}`);
	const credentials = new DesktopModelCredentialStore(vault);
	config = {
		defaultModel: "openai/gpt-existing",
		providers: {
			openai: {
				source: "template",
				templateId: "openai",
				credentialRef: "openai-key",
				models: [{ id: "gpt-existing", name: "Existing", maxTokens: 99 }],
			},
			personal: { credentialRef: "other-key", models: [{ id: "private-model" }] },
		},
	};
	writeConfig = vi.fn(async (next: ModelsConfig) => {
		config = structuredClone(next);
	});
	boundary.service = new ModelSettingsService({
		readConfig: async () => structuredClone(config),
		writeConfig,
		refreshRegistry: async () => {},
		credentials,
	});
	boundary.fetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "https://models.dev/api.json") return Response.json({ openai: { models: {} } });
		if (url === "https://api.openai.com/v1/models") {
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-openai-key");
			return Response.json({ data: [{ id: "gpt-new" }] });
		}
		throw new Error(`Unexpected fixture endpoint: ${url}`);
	});
	clearCryptographyCalls();
});

afterEach(() => {
	boundary.service = null;
	rmSync(boundary.home, { recursive: true, force: true });
});

function clearCryptographyCalls() {
	cryptography.isAvailable.mockClear();
	cryptography.encrypt.mockClear();
	cryptography.decrypt.mockClear();
}

function expectNoCryptography() {
	expect(cryptography.isAvailable).not.toHaveBeenCalled();
	expect(cryptography.encrypt).not.toHaveBeenCalled();
	expect(cryptography.decrypt).not.toHaveBeenCalled();
}

function ciphertext() {
	return Object.fromEntries(
		readdirSync(credentialDirectory).map((name) => [name, readFileSync(join(credentialDirectory, name), "utf8")]),
	);
}

describe("preset synchronization credential ownership", () => {
	it("startup with no adopted preset refreshes only the public catalog without unlocking unrelated keys", async () => {
		delete config.providers.openai.source;
		cryptography.available = false;
		const { syncAdoptedPresets } = await import("./sync.js");
		await syncAdoptedPresets();
		expectNoCryptography();
		expect(boundary.fetch).toHaveBeenCalledTimes(1);
		expect(boundary.fetch.mock.calls[0][0]).toBe("https://models.dev/api.json");
		expect(writeConfig).not.toHaveBeenCalled();
	});

	it("a locked adopted provider preserves models and ciphertext until the key is explicitly unlocked", async () => {
		cryptography.available = false;
		const before = structuredClone(config);
		const encrypted = ciphertext();
		const { syncAdoptedPresets } = await import("./sync.js");
		await syncAdoptedPresets();
		expectNoCryptography();
		expect(config).toEqual(before);
		expect(ciphertext()).toEqual(encrypted);
		expect(boundary.fetch).toHaveBeenCalledTimes(1);
		cryptography.available = true;
		await expect(boundary.service?.getProviderApiKey("openai")).resolves.toBe("fixture-openai-key");
		clearCryptographyCalls();
		await syncAdoptedPresets();
		expectNoCryptography();
		expect(config.providers.openai.models?.map((model) => model.id)).toEqual(["gpt-new"]);
		expect(config.providers.openai.credentialRef).toBe("openai-key");
		expect(config.providers.openai.apiKey).toBeUndefined();
		expect(ciphertext()).toEqual(encrypted);
	});

	it("an already unlocked custom key syncs using memory without another secure-storage access", async () => {
		await boundary.service?.getProviderApiKey("openai");
		clearCryptographyCalls();
		cryptography.available = false;
		const { syncAdoptedPresets } = await import("./sync.js");
		await syncAdoptedPresets();
		expectNoCryptography();
		expect(config.providers.openai.models?.map((model) => model.id)).toEqual(["gpt-new"]);
		expect(config.providers.personal.credentialRef).toBe("other-key");
		expect(config.defaultModel).toBe("openai/gpt-existing");
	});

	it.each([undefined, "***"])(
		"manual refresh reads only its requested provider and never transmits a mask: %s",
		async (input) => {
			const { refreshPresetModels } = await import("./sync.js");
			const result = await refreshPresetModels("openai", input);
			expect(result.error).toBeUndefined();
			expect(result.models.map((model) => model.id)).toEqual(["gpt-new"]);
			expect(cryptography.decrypt).toHaveBeenCalledTimes(1);
			expect(writeConfig).not.toHaveBeenCalled();
		},
	);

	it("legacy plaintext is reused without migration and a stored mask never becomes an API credential", async () => {
		delete config.providers.openai.credentialRef;
		config.providers.openai.apiKey = "fixture-openai-key";
		cryptography.available = false;
		const { syncAdoptedPresets } = await import("./sync.js");
		await syncAdoptedPresets();
		expectNoCryptography();
		expect(config.providers.openai.apiKey).toBe("fixture-openai-key");
		expect(config.providers.openai.models?.map((model) => model.id)).toEqual(["gpt-new"]);
		config.providers.openai.apiKey = "***";
		boundary.fetch.mockClear();
		await syncAdoptedPresets();
		expect(boundary.fetch).not.toHaveBeenCalled();
	});

	it("a response collected before a concurrent provider edit cannot overwrite the new metadata", async () => {
		await boundary.service?.getProviderApiKey("openai");
		let finish!: (response: Response) => void;
		let started!: () => void;
		const requested = new Promise<void>((resolve) => {
			started = resolve;
		});
		boundary.fetch.mockImplementation(async (url: string) => {
			if (url === "https://models.dev/api.json") return Response.json({ openai: { models: {} } });
			started();
			return new Promise<Response>((resolve) => {
				finish = resolve;
			});
		});
		const { syncAdoptedPresets } = await import("./sync.js");
		const syncing = syncAdoptedPresets();
		await requested;
		await boundary.service?.updateMetadataConfig((latest) => ({
			...latest,
			defaultModel: "openai/gpt-user-selected",
			providers: {
				...latest.providers,
				openai: { ...latest.providers.openai, models: [{ id: "gpt-user-selected" }] },
			},
		}));
		finish(Response.json({ data: [{ id: "gpt-new" }] }));
		await syncing;
		expect(config.providers.openai.models?.map((model) => model.id)).toEqual(["gpt-user-selected"]);
		expect(config.defaultModel).toBe("openai/gpt-user-selected");
	});
});
