import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialVault } from "../credentials/credential-vault.js";
import { PluginSecretsStore } from "./plugin-secrets-store.js";

/** 可用的假加密后端：只验证存储行为，不测 safeStorage 本身。 */
const cryptography = {
	backend: "test",
	isAvailable: () => true,
	encrypt: (plainText: string) => Buffer.from(plainText, "utf8").toString("base64"),
	decrypt: (cipherText: string) => Buffer.from(cipherText, "base64").toString("utf8"),
};

let root: string;
let store: PluginSecretsStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "plugin-secrets-"));
	store = new PluginSecretsStore(new CredentialVault(root, cryptography));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("PluginSecretsStore", () => {
	it("reads missing plugin secrets and metadata without probing native encryption", () => {
		const forbidden = vi.fn(() => {
			throw new Error("Unexpected native encryption access");
		});
		const isolated = new PluginSecretsStore(
			new CredentialVault(root, {
				backend: "denied-fixture",
				isAvailable: forbidden,
				encrypt: forbidden,
				decrypt: forbidden,
			}),
		);
		expect(isolated.get("content-creation", "providerKey")).toBeUndefined();
		expect(isolated.has("content-creation", "providerKey")).toBe(false);
		expect(isolated.keys("content-creation")).toEqual([]);
		expect(() => isolated.get("content-creation", " bad-key")).toThrow("Invalid plugin secret key");
		expect(forbidden).not.toHaveBeenCalled();
		expect(readdirSync(root)).toEqual([]);
	});

	it("keeps the secure-storage gate and original ciphertext for an existing unavailable secret", () => {
		store.set("content-creation", "providerKey", "synthetic-existing-secret");
		const snapshot = () => readdirSync(root).map((name) => readFileSync(join(root, name), "utf8"));
		const before = snapshot();
		const available = vi.fn(() => false);
		const decrypt = vi.fn(() => {
			throw new Error("Must not decrypt an unavailable secret");
		});
		const encrypt = vi.fn(() => {
			throw new Error("Must not overwrite an unavailable secret");
		});
		const isolated = new PluginSecretsStore(
			new CredentialVault(root, { backend: "denied-fixture", isAvailable: available, encrypt, decrypt }),
		);
		expect(isolated.get("content-creation", "providerKey")).toBeUndefined();
		expect(available).toHaveBeenCalledTimes(1);
		expect(decrypt).not.toHaveBeenCalled();
		expect(encrypt).not.toHaveBeenCalled();
		expect(snapshot()).toEqual(before);
	});

	it("round-trips a secret and lists only key names", () => {
		store.set("demo", "apiKey", "sk-live-1");

		expect(store.get("demo", "apiKey")).toBe("sk-live-1");
		expect(store.has("demo", "apiKey")).toBe(true);
		expect(store.keys("demo")).toEqual(["apiKey"]);
	});

	it("keeps each plugin inside its own namespace", () => {
		store.set("demo", "apiKey", "sk-demo");
		store.set("other", "apiKey", "sk-other");

		expect(store.get("other", "apiKey")).toBe("sk-other");
		expect(store.keys("demo")).toEqual(["apiKey"]);
		expect(store.get("demo", "apiKey")).toBe("sk-demo");
	});

	it("treats an empty value as a delete so no unreadable record is left behind", () => {
		store.set("demo", "apiKey", "sk-live-1");
		store.set("demo", "apiKey", "");

		expect(store.has("demo", "apiKey")).toBe(false);
		expect(store.get("demo", "apiKey")).toBeUndefined();
		expect(store.keys("demo")).toEqual([]);
	});

	it("clears every secret a plugin owns without touching others", () => {
		store.set("demo", "apiKey", "sk-demo");
		store.set("demo", "token", "tk-demo");
		store.set("other", "apiKey", "sk-other");

		store.clear("demo");

		expect(store.keys("demo")).toEqual([]);
		expect(store.get("other", "apiKey")).toBe("sk-other");
	});

	it("rejects keys that are empty or carry surrounding whitespace", () => {
		expect(() => store.set("demo", " apiKey", "x")).toThrow("Invalid plugin secret key");
		expect(() => store.get("demo", "")).toThrow("Invalid plugin secret key");
	});
});
