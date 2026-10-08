import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingUri } from "@vetta/remote-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../shared/notification-preferences.js";
import type { DesktopConfig } from "../config/desktop-config-store.js";
import { type CredentialCryptography, CredentialVault } from "../credentials/credential-vault.js";
import { DesktopRemoteAccessManager, type RemoteAccessState } from "./desktop-remote-access-manager.js";
import { RemoteDeviceStore } from "./remote-device-store.js";

vi.mock("../logger.js", () => ({ getAppLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

class FixtureCryptography implements CredentialCryptography {
	readonly backend = "isolated-remote-credential-fixture";
	mode: "allowed" | "unavailable" | "denied" = "denied";
	readonly isAvailable = vi.fn(() => {
		if (this.mode === "denied") throw new Error("Unexpected keychain probe");
		return this.mode === "allowed";
	});
	readonly encrypt = vi.fn((value: string) => {
		if (this.mode !== "allowed") throw new Error("Fixture keychain denied");
		return Buffer.from(value).toString("base64");
	});
	readonly decrypt = vi.fn((value: string) => {
		if (this.mode !== "allowed") throw new Error("Fixture keychain denied");
		return Buffer.from(value, "base64").toString();
	});
	resetCalls(): void {
		this.isAvailable.mockClear();
		this.encrypt.mockClear();
		this.decrypt.mockClear();
	}
}

const fixtures: Array<{ directory: string; manager: DesktopRemoteAccessManager }> = [];

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "remote-state-credentials-"));
	const cryptography = new FixtureCryptography();
	const vault = new CredentialVault(directory, cryptography);
	let config: DesktopConfig = {
		schemaVersion: 1,
		projects: [],
		archivedProjects: [],
		workspacePath: directory,
		defaultExecutionMode: "sandbox",
		notificationPreferences: structuredClone(DEFAULT_NOTIFICATION_PREFERENCES),
		remoteControl: { cloudEnabled: false, devices: [] },
	};
	const store = new RemoteDeviceStore({
		vault,
		readConfig: async () => structuredClone(config),
		updateConfig: async (update) => {
			config = await update(structuredClone(config));
			return structuredClone(config);
		},
	});
	const manager = new DesktopRemoteAccessManager({
		store,
		deviceId: "isolated-desktop",
		deviceName: "Fixture desktop",
		runningSessionCount: () => 0,
		listLanEndpoints: () => ["127.0.0.1:43117"],
		notifications: { deviceConnected: () => {}, pairingRequested: () => {} },
		createMirror: () => {
			throw new Error("No phone should connect in this fixture");
		},
		createLanServer: () => ({
			start: async () => 43117,
			stop: async () => {},
			listeningPort: 43117,
		}),
	});
	fixtures.push({ directory, manager });
	const records = () =>
		Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")]));
	return { manager, store, vault, cryptography, records, config: () => structuredClone(config) };
}

function expectNoCryptography(cryptography: FixtureCryptography): void {
	expect(cryptography.isAvailable).not.toHaveBeenCalled();
	expect(cryptography.encrypt).not.toHaveBeenCalled();
	expect(cryptography.decrypt).not.toHaveBeenCalled();
}

afterEach(async () => {
	for (const { manager, directory } of fixtures.splice(0)) {
		await manager.shutdown();
		rmSync(directory, { recursive: true, force: true });
	}
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("remote status queries and the credential boundary", () => {
	it("restores an unpaired desktop and emits status without probing the keychain", async () => {
		vi.useFakeTimers();
		const { manager, cryptography, records } = fixture();
		const states: RemoteAccessState[] = [];
		const unsubscribe = manager.onStateChanged((state) => states.push(state));
		await manager.restore();
		for (let i = 0; i < 3; i += 1) expect(manager.getState().vaultAvailable).toBeNull();
		await vi.runOnlyPendingTimersAsync();
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({ devices: [], vaultAvailable: null });
		expectNoCryptography(cryptography);
		expect(records()).toEqual({});
		unsubscribe();
	});

	it("projects an active invite after the keychain locks without reading private credentials again", async () => {
		vi.useFakeTimers();
		const { manager, cryptography, records, config } = fixture();
		cryptography.mode = "allowed";
		await manager.restore();
		const created = await manager.createInvite();
		const original = records();
		expect(created.vaultAvailable).toBe(true);
		const mobileSecret = parsePairingUri(created.invite?.inviteUri ?? "").mobileSecret;
		expect(mobileSecret).toBeTruthy();
		expect(JSON.stringify(original)).not.toContain(mobileSecret);
		expect(JSON.stringify(config())).not.toContain(mobileSecret);
		expect(cryptography.encrypt).toHaveBeenCalled();
		const states: RemoteAccessState[] = [];
		const unsubscribe = manager.onStateChanged((state) => states.push(state));
		cryptography.mode = "denied";
		cryptography.resetCalls();
		expect(manager.getState().invite).toEqual(created.invite);
		await manager.renameDevice(created.devices[0]?.id ?? "", "Renamed fixture phone");
		await vi.advanceTimersByTimeAsync(0);
		expect(states.at(-1)?.invite).toEqual(created.invite);
		expectNoCryptography(cryptography);
		expect(records()).toEqual(original);
		await manager.cancelInvite();
		expect(manager.getState().invite).toBeUndefined();
		expectNoCryptography(cryptography);
		unsubscribe();
	});

	it("still rejects explicit pairing when encryption is unavailable and permits a later explicit retry", async () => {
		const { manager, cryptography, records, config } = fixture();
		cryptography.mode = "unavailable";
		await manager.restore();
		await expect(manager.createInvite()).rejects.toThrow("安全凭据存储");
		expect(cryptography.isAvailable).toHaveBeenCalledTimes(1);
		expect(records()).toEqual({});
		expect(config().remoteControl?.devices).toEqual([]);
		cryptography.resetCalls();
		expect(manager.getState().vaultAvailable).toBe(false);
		expectNoCryptography(cryptography);
		cryptography.mode = "allowed";
		expect((await manager.createInvite()).invite).toBeDefined();
		expect(cryptography.encrypt).toHaveBeenCalled();
	});
});
