import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialCryptography, CredentialVault } from "../credentials/credential-vault.js";
import { DesktopModelCredentialStore } from "./model-credential-store.js";
import { ModelSettingsService, type ModelsConfig, type ProviderConfig } from "./model-settings-service.js";

vi.mock("../credentials/desktop-credential-vault.js", () => ({ getDesktopCredentialVault: vi.fn() }));
vi.mock("../logger.js", () => ({ getAppLogger: () => ({ warn: vi.fn() }) }));

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class SwitchableCryptography implements CredentialCryptography {
	readonly backend = "isolated-test";
	available = true;
	decryptDenied = false;
	encryptDenied = false;
	encryptCount = 0;
	denyOnEncryption = Number.POSITIVE_INFINITY;

	isAvailable(): boolean {
		return this.available;
	}

	encrypt(value: string): string {
		this.encryptCount++;
		if (this.encryptCount === this.denyOnEncryption) this.available = false;
		if (!this.available || this.encryptDenied) throw new Error("isolated keychain refusal");
		return Buffer.from(value).toString("base64");
	}

	decrypt(value: string): string {
		if (this.decryptDenied) throw new Error("isolated keychain refusal");
		return Buffer.from(value, "base64").toString("utf8");
	}
}

function fixture(
	options: { managed?: boolean; resolveManagedApiKey?: (provider: ProviderConfig) => string | undefined } = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "model-settings-credential-recovery-"));
	directories.push(directory);
	const cryptography = new SwitchableCryptography();
	const vault = new CredentialVault(directory, cryptography);
	const credentials = new DesktopModelCredentialStore(vault);
	credentials.set("existing", "fixture-original-key");
	let config: ModelsConfig = {
		defaultModel: "personal/model",
		providers: {
			personal: {
				credentialRef: "existing",
				models: [{ id: "model" }],
				...(options.managed
					? { managedGroup: { source: "flowstoken" as const, accountId: 7, groupId: "default", tokenId: 10 } }
					: {}),
			},
		},
	};
	const before = structuredClone(config);
	const encryptedFiles = () =>
		Object.fromEntries(
			readdirSync(directory)
				.sort()
				.map((name) => [name, readFileSync(join(directory, name), "utf8")]),
		);
	const originalRecords = encryptedFiles();
	const writeConfig = vi.fn(async (next: ModelsConfig) => {
		config = structuredClone(next);
	});
	const refreshRegistry = vi.fn(async () => {});
	const service = new ModelSettingsService({
		readConfig: async () => structuredClone(config),
		writeConfig,
		refreshRegistry,
		credentials,
		resolveManagedApiKey: options.resolveManagedApiKey,
	});
	const replacement = (includeNew = false): ModelsConfig => ({
		...before,
		providers: {
			personal: { ...before.providers.personal, apiKey: "fixture-replacement-key" },
			...(includeNew ? { fresh: { apiKey: "fixture-new-key", models: [{ id: "new-model" }] } } : {}),
		},
	});
	return {
		cryptography,
		credentials,
		service,
		before,
		readConfig: () => config,
		writeConfig,
		refreshRegistry,
		encryptedFiles,
		originalRecords,
		replacement,
	};
}

describe("ModelSettingsService encrypted credential rollback", () => {
	it.each(["keychain-refused", "backend-unavailable"])(
		"preserves existing ciphertext after %s prevents a settings update",
		async (failure) => {
			const f = fixture();
			if (failure === "backend-unavailable") f.cryptography.available = false;
			else {
				f.cryptography.decryptDenied = true;
				f.cryptography.encryptDenied = true;
			}
			await expect(f.service.replaceConfig(f.replacement())).rejects.toThrow();
			expect(f.credentials.has("existing")).toBe(true);
			expect(f.encryptedFiles()).toEqual(f.originalRecords);
			expect(f.readConfig()).toEqual(f.before);
			expect(f.writeConfig).not.toHaveBeenCalled();
		},
	);

	it("refuses to overwrite an unreadable credential even when encryption could still succeed", async () => {
		const f = fixture();
		f.cryptography.decryptDenied = true;
		await expect(f.service.replaceConfig(f.replacement())).rejects.toMatchObject({
			code: "MODEL_CREDENTIAL_UNAVAILABLE",
		});
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		expect(f.readConfig()).toEqual(f.before);
	});

	it("restores the original ciphertext if a later credential write loses secure storage", async () => {
		const f = fixture();
		f.cryptography.denyOnEncryption = f.cryptography.encryptCount + 2;
		await expect(f.service.replaceConfig(f.replacement(true))).rejects.toThrow();
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		expect(f.readConfig()).toEqual(f.before);
		expect(f.writeConfig).not.toHaveBeenCalled();
	});

	it("rolls back an update and a new credential after config persistence fails with the keychain unavailable", async () => {
		const f = fixture();
		f.writeConfig.mockImplementationOnce(async () => {
			f.cryptography.available = false;
			throw new Error("fixture config write failed");
		});
		await expect(f.service.replaceConfig(f.replacement(true))).rejects.toThrow("fixture config write failed");
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		expect(f.readConfig()).toEqual(f.before);
		expect(f.refreshRegistry).not.toHaveBeenCalled();
	});

	it("restores a removed credential without decrypting when config persistence fails", async () => {
		const f = fixture();
		f.writeConfig.mockImplementationOnce(async () => {
			f.cryptography.available = false;
			throw new Error("fixture config write failed");
		});
		await expect(f.service.removeProvider("personal")).rejects.toThrow("fixture config write failed");
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		expect(f.readConfig()).toEqual(f.before);
	});

	it("keeps read-only configuration available while the existing key is temporarily inaccessible", async () => {
		const f = fixture();
		f.cryptography.decryptDenied = true;
		await expect(f.service.getConfig()).resolves.toEqual(f.before);
		await expect(f.service.getRendererConfig()).resolves.toMatchObject({
			providers: { personal: { credentialRef: "existing", apiKey: "***" } },
		});
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
	});

	it("does not destroy an unreadable encrypted record while migrating legacy plaintext", async () => {
		const f = fixture();
		f.readConfig().providers.personal.apiKey = "fixture-legacy-key";
		f.cryptography.decryptDenied = true;
		f.cryptography.encryptDenied = true;
		await expect(f.service.getConfig()).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_UNAVAILABLE" });
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		expect(f.readConfig().providers.personal.apiKey).toBe("fixture-legacy-key");
		expect(f.writeConfig).not.toHaveBeenCalled();
	});

	it("retries a deferred custom plaintext migration when secure storage becomes available", async () => {
		const f = fixture();
		f.readConfig().providers.personal.apiKey = "fixture-legacy-key";
		f.cryptography.available = false;
		await f.service.getConfig();
		expect(f.readConfig().providers.personal.apiKey).toBe("fixture-legacy-key");
		f.cryptography.available = true;
		await f.service.getConfig();
		await expect(f.service.getProviderApiKey("personal")).resolves.toBe("fixture-legacy-key");
		expect(f.readConfig().providers.personal.apiKey).toBeUndefined();
	});

	it("restores configuration and original ciphertext when an account commit is canceled after persistence", async () => {
		const f = fixture();
		const write = f.writeConfig.getMockImplementation();
		if (!write) throw new Error("Fixture write implementation is missing");
		f.writeConfig.mockImplementation(async (next) => {
			await write(next);
			f.cryptography.available = false;
		});
		await expect(
			f.service.updateConfig(
				() => f.replacement(true),
				() => {
					if (!f.cryptography.available) throw new Error("fixture account changed");
				},
			),
		).rejects.toThrow("fixture account changed");
		expect(f.readConfig()).toEqual(f.before);
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		expect(f.refreshRegistry).not.toHaveBeenCalled();
	});
});

describe("ModelSettingsService managed session credentials", () => {
	function observeVault(f: ReturnType<typeof fixture>) {
		return [
			vi.spyOn(f.credentials, "isAvailable"),
			vi.spyOn(f.credentials, "get"),
			vi.spyOn(f.credentials, "set"),
			vi.spyOn(f.credentials, "remove"),
			vi.spyOn(f.cryptography, "isAvailable"),
		];
	}

	it("reads and refreshes a managed provider using session keys without touching the old encrypted record", async () => {
		const f = fixture({ managed: true, resolveManagedApiKey: () => "fixture-session-key" });
		f.cryptography.available = false;
		const operations = observeVault(f);
		await expect(f.service.getProviderApiKey("personal")).resolves.toBe("fixture-session-key");
		const renderer = await f.service.getRendererConfig();
		renderer.providers.personal.displayName = "Renamed managed group";
		await f.service.replaceConfig(renderer);
		await f.service.updateConfig(
			(current) => ({
				...current,
				providers: { personal: { ...current.providers.personal, models: [{ id: "new-model" }] } },
			}),
			() => {},
		);
		expect(f.readConfig().providers.personal).toMatchObject({
			credentialRef: "existing",
			managedGroup: f.before.providers.personal.managedGroup,
			models: [{ id: "new-model" }],
		});
		expect(f.readConfig().providers.personal.apiKey).toBeUndefined();
		expect(f.readConfig().providers.personal.managedGroupOverride).toBeUndefined();
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
	});

	it("does not fall back to a vault or legacy plaintext when the current session has no managed key", async () => {
		const f = fixture({ managed: true, resolveManagedApiKey: () => undefined });
		f.readConfig().providers.personal.apiKey = "fixture-old-plaintext";
		const operations = observeVault(f);
		await expect(f.service.getProviderApiKey("personal")).resolves.toBeUndefined();
		expect((await f.service.getRendererConfig()).providers.personal.apiKey).toBeUndefined();
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
		expect(f.writeConfig).not.toHaveBeenCalled();
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
	});

	it("stores only metadata for a new managed provider and still exposes its masked session key", async () => {
		const f = fixture({ managed: true, resolveManagedApiKey: () => "fixture-session-key" });
		f.cryptography.available = false;
		const operations = observeVault(f);
		await f.service.updateConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					newManaged: {
						apiKey: "fixture-new-session-key",
						managedGroup: { source: "flowstoken", accountId: 7, groupId: "smart", tokenId: 11 },
						models: [{ id: "smart-model" }],
					},
				},
			}),
			() => {},
		);
		expect(f.readConfig().providers.newManaged.apiKey).toBeUndefined();
		expect(f.readConfig().providers.newManaged.credentialRef).toBeUndefined();
		expect((await f.service.getRendererConfig()).providers.newManaged.apiKey).toBe("***");
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
	});

	it("preserves old managed ciphertext when removing its provider", async () => {
		const f = fixture({ managed: true, resolveManagedApiKey: () => "fixture-session-key" });
		f.cryptography.available = false;
		const operations = observeVault(f);
		await f.service.removeProvider("personal");
		expect(f.readConfig()).toEqual({ providers: {} });
		expect(f.encryptedFiles()).toEqual(f.originalRecords);
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
	});

	it("persists an explicit personal override under a new reference without overwriting the old managed cipher", async () => {
		const f = fixture({ managed: true, resolveManagedApiKey: () => "fixture-session-key" });
		f.cryptography.decryptDenied = true;
		const reads = vi.spyOn(f.credentials, "get");
		const renderer = await f.service.getRendererConfig();
		renderer.providers.personal.apiKey = "fixture-personal-override";
		await f.service.replaceConfig(renderer);
		expect(f.readConfig().providers.personal.managedGroup).toBeUndefined();
		expect(f.readConfig().providers.personal.managedGroupOverride).toBe(true);
		expect(f.readConfig().providers.personal.credentialRef).not.toBe("existing");
		expect(f.readConfig().providers.personal.apiKey).toBeUndefined();
		expect(reads).not.toHaveBeenCalledWith("existing");
		for (const [name, body] of Object.entries(f.originalRecords)) expect(f.encryptedFiles()[name]).toBe(body);
		f.cryptography.decryptDenied = false;
		await expect(f.service.getProviderApiKey("personal")).resolves.toBe("fixture-personal-override");
	});

	it("continues normal persistent custom-provider operations when a managed resolver is installed", async () => {
		const resolver = vi.fn(() => "fixture-managed-key");
		const f = fixture({ resolveManagedApiKey: resolver });
		await f.service.replaceConfig(f.replacement());
		await expect(f.service.getProviderApiKey("personal")).resolves.toBe("fixture-replacement-key");
		await f.service.removeProvider("personal");
		expect(f.encryptedFiles()).toEqual({});
		expect(resolver).not.toHaveBeenCalled();
	});

	it("does not probe secure-storage availability when reading a config without plaintext to migrate", async () => {
		const f = fixture();
		const available = vi.spyOn(f.credentials, "isAvailable");
		await f.service.getRendererConfig();
		expect(available).not.toHaveBeenCalled();
	});

	it("reads renderer metadata without probing a custom legacy plaintext key or decrypting another custom key", async () => {
		const f = fixture();
		f.readConfig().providers.legacy = { apiKey: "fixture-unmodified-legacy", models: [{ id: "legacy-model" }] };
		f.cryptography.available = false;
		const operations = observeVault(f);
		const renderer = await f.service.getRendererConfig();
		expect(renderer.providers.legacy.apiKey).toBe("***");
		expect(renderer.providers.personal.apiKey).toBe("***");
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
	});

	it("resolves only the explicitly requested provider without migrating or opening unrelated custom credentials", async () => {
		const f = fixture();
		f.readConfig().providers.target = { apiKey: "fixture-requested-plaintext" };
		f.cryptography.available = false;
		const operations = observeVault(f);
		await expect(f.service.getProviderApiKey("target")).resolves.toBe("fixture-requested-plaintext");
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
		expect(f.readConfig().providers.target.apiKey).toBe("fixture-requested-plaintext");
	});

	it("updates managed metadata without migrating or changing mixed custom ciphertext and legacy plaintext", async () => {
		const f = fixture({ managed: true, resolveManagedApiKey: () => "fixture-session-key" });
		f.credentials.set("custom-ref", "fixture-persisted-custom");
		f.credentials.set("legacy-ref", "fixture-old-legacy-cipher");
		f.readConfig().providers.custom = {
			credentialRef: "custom-ref",
			models: [{ id: "custom-model", maxTokens: 222 }],
		};
		f.readConfig().providers.legacy = {
			apiKey: "fixture-legacy-plaintext",
			credentialRef: "legacy-ref",
			models: [{ id: "legacy-model" }],
		};
		const beforeCustom = structuredClone(f.readConfig().providers.custom);
		const beforeLegacy = structuredClone(f.readConfig().providers.legacy);
		const beforeCipher = f.encryptedFiles();
		f.cryptography.available = false;
		const operations = observeVault(f);
		const metadata = await f.service.getMetadataConfig();
		expect(metadata.providers.custom.apiKey).toBe("***");
		expect(metadata.providers.legacy.apiKey).toBe("***");
		await f.service.updateMetadataConfig(
			(current) => ({
				...current,
				providers: {
					...current.providers,
					personal: {
						...current.providers.personal,
						apiKey: "fixture-refreshed-session",
						models: [{ id: "new" }],
					},
				},
			}),
			() => {},
		);
		await f.service.list();
		await f.service.getSanitizedConfig();
		await f.service.getSanitizedProvider("custom");
		await f.service.validateModelKey("custom/custom-model");
		await f.service.listOwnedProviders("a-plugin");
		await f.service.setDefault("custom/custom-model");
		expect(f.readConfig().providers.custom).toEqual(beforeCustom);
		expect(f.readConfig().providers.legacy).toEqual(beforeLegacy);
		expect(f.readConfig().providers.personal.apiKey).toBeUndefined();
		expect(f.readConfig().providers.personal.credentialRef).toBe("existing");
		expect(f.encryptedFiles()).toEqual(beforeCipher);
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
	});

	it("reads only previously authorized keys for background sync without probing the vault", async () => {
		const f = fixture({ managed: true, resolveManagedApiKey: () => "fixture-session-key" });
		f.credentials.set("custom-ref", "fixture-cached-custom");
		f.readConfig().providers.custom = { credentialRef: "custom-ref" };
		f.readConfig().providers.uncached = { credentialRef: "never-read" };
		f.readConfig().providers.legacy = { apiKey: "fixture-existing-plaintext" };
		f.cryptography.available = false;
		const operations = observeVault(f);
		await expect(f.service.getCachedProviderApiKey("personal")).resolves.toBe("fixture-session-key");
		await expect(f.service.getCachedProviderApiKey("custom")).resolves.toBe("fixture-cached-custom");
		await expect(f.service.getCachedProviderApiKey("uncached")).resolves.toBeUndefined();
		await expect(f.service.getCachedProviderApiKey("legacy")).resolves.toBe("fixture-existing-plaintext");
		for (const operation of operations) expect(operation).not.toHaveBeenCalled();
	});
});
