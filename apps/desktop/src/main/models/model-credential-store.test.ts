import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialCryptography, CredentialVault } from "../credentials/credential-vault.js";
import { DesktopModelCredentialStore, ModelCredentialUnavailableError } from "./model-credential-store.js";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("../credentials/desktop-credential-vault.js", () => ({ getDesktopCredentialVault: vi.fn() }));
vi.mock("../logger.js", () => ({ getAppLogger: () => ({ warn: logWarn }) }));

const temporaryDirectories: string[] = [];

afterEach(() => {
	logWarn.mockClear();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DesktopModelCredentialStore", () => {
	it("treats credentials encrypted with another safeStorage key as unavailable", () => {
		const vault = new CredentialVault(createTemporaryDirectory(), new UndecryptableCryptography());
		const store = new DesktopModelCredentialStore(vault);
		store.set("deepseek-credential", "secret");

		expect(store.get("deepseek-credential")).toBeUndefined();
		expect(logWarn).toHaveBeenCalledWith(
			"模型凭据暂不可访问，保留原凭据",
			expect.objectContaining({ credentialRef: "deepseek-credential" }),
		);
		expect(store.has("deepseek-credential")).toBe(true);
		expect(store.get("missing")).toBeUndefined();
		expect(store.has("missing")).toBe(false);
	});

	it("rejects mutations of inaccessible ciphertext while leaving non-fatal reads available", () => {
		const directory = createTemporaryDirectory();
		const vault = new CredentialVault(directory, new UndecryptableCryptography());
		const store = new DesktopModelCredentialStore(vault);
		store.set("existing", "fixture-original");
		const files = () => readdirSync(directory).map((name) => readFileSync(join(directory, name), "utf8"));
		const original = files();

		expect(() => store.set("existing", "fixture-replacement")).toThrow(ModelCredentialUnavailableError);
		expect(() => store.remove("existing")).toThrow(ModelCredentialUnavailableError);
		expect(() => store.createRestorePoint("existing")).toThrow(ModelCredentialUnavailableError);
		expect(files()).toEqual(original);
		expect(store.get("existing")).toBeUndefined();
	});

	it("peeks only process-authorized keys and invalidates them after read failure, removal or rollback", () => {
		const directory = createTemporaryDirectory();
		const cryptography = {
			backend: "test",
			isAvailable: vi.fn(() => true),
			encrypt: vi.fn((value: string) => Buffer.from(value).toString("base64")),
			decrypt: vi.fn((value: string) => Buffer.from(value, "base64").toString("utf8")),
		};
		const vault = new CredentialVault(directory, cryptography);
		vault.put({ namespace: "models", ownerId: "existing", name: "api-key" }, "fixture-old");
		const store = new DesktopModelCredentialStore(vault);
		expect(store.peek("existing")).toBeUndefined();
		expect(store.get("existing")).toBe("fixture-old");
		cryptography.isAvailable.mockClear();
		cryptography.decrypt.mockClear();
		expect(store.peek("existing")).toBe("fixture-old");
		expect(cryptography.isAvailable).not.toHaveBeenCalled();
		expect(cryptography.decrypt).not.toHaveBeenCalled();
		cryptography.decrypt.mockImplementationOnce(() => {
			throw new Error("fixture denied");
		});
		expect(store.get("existing")).toBeUndefined();
		expect(store.peek("existing")).toBeUndefined();
		store.set("new", "fixture-new");
		expect(store.peek("new")).toBe("fixture-new");
		const restore = store.createRestorePoint("new");
		store.set("new", "fixture-replaced");
		restore();
		expect(store.peek("new")).toBeUndefined();
		expect(store.get("new")).toBe("fixture-new");
		store.remove("new");
		expect(store.peek("new")).toBeUndefined();
	});
});

class UndecryptableCryptography implements CredentialCryptography {
	readonly backend = "test";

	isAvailable(): boolean {
		return true;
	}

	encrypt(plainText: string): string {
		return Buffer.from(plainText, "utf8").toString("base64");
	}

	decrypt(): string {
		throw new Error("ciphertext belongs to another safeStorage key");
	}
}

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "vetta-model-credential-store-"));
	temporaryDirectories.push(directory);
	return directory;
}
