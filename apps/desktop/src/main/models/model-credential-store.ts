import type { CodingAgentAuthRuntime } from "@vetta/coding-agent/host-services";
import type { CredentialVault } from "../credentials/credential-vault.js";
import { getDesktopCredentialVault } from "../credentials/desktop-credential-vault.js";
import { getAppLogger } from "../logger.js";

const MODEL_CREDENTIAL_NAMESPACE = "models";
const MODEL_API_KEY_NAME = "api-key";
const modelCredentialLog = getAppLogger("model-credentials");

export interface ModelCredentialStore {
	isAvailable(): boolean;
	has(credentialRef: string): boolean;
	get(credentialRef: string): string | undefined;
	/** Already authorized in this process; never reads the vault or probes secure storage. */
	peek?(credentialRef: string): string | undefined;
	set(credentialRef: string, value: string): void;
	remove(credentialRef: string): void;
	/** Persistent stores can restore ciphertext without re-entering secure storage during rollback. */
	createRestorePoint?(credentialRef: string): () => void;
}

export class ModelCredentialUnavailableError extends Error {
	readonly code = "MODEL_CREDENTIAL_UNAVAILABLE";

	constructor() {
		super("Secure model credential storage is temporarily unavailable");
		this.name = "ModelCredentialUnavailableError";
	}
}

export class DesktopModelCredentialStore implements ModelCredentialStore {
	private syncedProviderIds = new Set<string>();
	private readonly resolvedCredentials = new Map<string, string>();

	constructor(private readonly vault: CredentialVault) {}

	isAvailable(): boolean {
		return this.vault.isAvailable();
	}

	has(credentialRef: string): boolean {
		return this.vault.has(modelApiKeyRef(credentialRef));
	}

	get(credentialRef: string): string | undefined {
		try {
			const value = this.vault.get(modelApiKeyRef(credentialRef));
			if (value === undefined) this.resolvedCredentials.delete(credentialRef);
			else this.resolvedCredentials.set(credentialRef, value);
			return value;
		} catch (error) {
			this.resolvedCredentials.delete(credentialRef);
			modelCredentialLog.warn("模型凭据暂不可访问，保留原凭据", {
				credentialRef,
				errorType: error instanceof Error ? error.name : "unknown",
			});
			return undefined;
		}
	}

	peek(credentialRef: string): string | undefined {
		return this.resolvedCredentials.get(credentialRef);
	}

	set(credentialRef: string, value: string): void {
		this.assertExistingCredentialReadable(credentialRef);
		try {
			this.vault.put(modelApiKeyRef(credentialRef), value, {
				kind: "api-key",
				consumer: "model-provider",
			});
			this.resolvedCredentials.set(credentialRef, value);
		} catch {
			this.resolvedCredentials.delete(credentialRef);
			throw new ModelCredentialUnavailableError();
		}
	}

	remove(credentialRef: string): void {
		this.assertExistingCredentialReadable(credentialRef);
		try {
			this.vault.remove(modelApiKeyRef(credentialRef));
		} finally {
			this.resolvedCredentials.delete(credentialRef);
		}
	}

	createRestorePoint(credentialRef: string): () => void {
		this.assertExistingCredentialReadable(credentialRef);
		const restore = this.vault.createRestorePoint(modelApiKeyRef(credentialRef));
		return () => {
			try {
				restore();
			} finally {
				this.resolvedCredentials.delete(credentialRef);
			}
		};
	}

	private assertExistingCredentialReadable(credentialRef: string): void {
		if (this.has(credentialRef) && this.get(credentialRef) === undefined) throw new ModelCredentialUnavailableError();
	}

	syncToAuthStorage(authStorage: CodingAgentAuthRuntime, providers: Record<string, { credentialRef?: string }>): void {
		const nextProviderIds = new Set<string>();
		for (const [providerId, provider] of Object.entries(providers)) {
			if (!provider.credentialRef) continue;
			const apiKey = this.get(provider.credentialRef);
			if (!apiKey) continue;
			authStorage.setRuntimeApiKey(providerId, apiKey);
			nextProviderIds.add(providerId);
		}
		for (const providerId of this.syncedProviderIds) {
			if (!nextProviderIds.has(providerId)) authStorage.removeRuntimeApiKey(providerId);
		}
		this.syncedProviderIds = nextProviderIds;
	}
}

let desktopModelCredentialStore: DesktopModelCredentialStore | undefined;

export function getDesktopModelCredentialStore(): DesktopModelCredentialStore {
	desktopModelCredentialStore ??= new DesktopModelCredentialStore(getDesktopCredentialVault());
	return desktopModelCredentialStore;
}

function modelApiKeyRef(credentialRef: string) {
	return {
		namespace: MODEL_CREDENTIAL_NAMESPACE,
		ownerId: credentialRef,
		name: MODEL_API_KEY_NAME,
	};
}
