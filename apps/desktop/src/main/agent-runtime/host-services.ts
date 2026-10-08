// Shared Desktop host services used by the production Agent Runtime composition.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@vetta/coding-agent/config";
import {
	AuthStorage,
	type CodingAgentAuthRuntime,
	type CodingAgentModelRuntime,
	createCodingAgentModelRuntime,
	SettingsRuntime,
} from "@vetta/coding-agent/host-services";
import { resolveProjectSettingsPath } from "@vetta/runtime-desktop";
import {
	NodeScopedTextStorage,
	NodeTransactionalTextStorage,
	nodeConfigurationValueResolver,
	nodeSyncTextFileSource,
} from "@vetta/runtime-node/host";
import { DEFAULT_SERVER_URL } from "../constants.js";
import { assertFlowstokenModelAccess } from "../flowstoken/catalog-access.js";
import {
	isManagedCredentialProvider,
	onManagedCredentialsChanged,
	resolveManagedApiKey,
} from "../flowstoken/managed-credentials.js";
import { getDesktopModelCredentialStore, type ModelCredentialStore } from "../models/model-credential-store.js";
import { type ProviderConfig, readModelsConfigSync } from "../models/model-settings-service.js";

let sharedModelRuntime: CodingAgentModelRuntime | undefined;
let sharedModelAuth: CodingAgentAuthRuntime | undefined;
let syncedCredentialProviderIds = new Set<string>();
let managedGroupBindings: Readonly<Record<string, ProviderConfig["managedGroup"]>> = {};
type RuntimeCredentialProvider = Pick<ProviderConfig, "credentialRef" | "managedGroup" | "managedGroupOverride">;
let credentialProviders: Readonly<Record<string, RuntimeCredentialProvider>> = {};
let modelCredentials: ModelCredentialStore | undefined;

function injectProviderCredential(providerId: string, key: string | undefined): void {
	if (!sharedModelAuth) return;
	if (key) {
		sharedModelAuth.setRuntimeApiKey(providerId, key);
		syncedCredentialProviderIds.add(providerId);
	} else {
		sharedModelAuth.removeRuntimeApiKey(providerId);
		syncedCredentialProviderIds.delete(providerId);
	}
}

function hydrateProviderCredential(providerId: string): void {
	const provider = credentialProviders[providerId];
	if (!provider) return;
	if (isManagedCredentialProvider(provider)) {
		injectProviderCredential(providerId, resolveManagedApiKey(provider));
	} else if (provider.credentialRef) {
		injectProviderCredential(providerId, modelCredentials?.get(provider.credentialRef));
	}
}

onManagedCredentialsChanged(() => {
	for (const [providerId, provider] of Object.entries(credentialProviders)) {
		if (isManagedCredentialProvider(provider)) injectProviderCredential(providerId, resolveManagedApiKey(provider));
	}
});

export function getOrCreateSharedModelRuntime(): CodingAgentModelRuntime {
	if (sharedModelRuntime) return sharedModelRuntime;
	const agentDir = getAgentDir();
	const authStorage = AuthStorage.fromStorage(new NodeTransactionalTextStorage(join(agentDir, "auth.json")), {
		configurationValueResolver: nodeConfigurationValueResolver,
	});
	sharedModelAuth = authStorage;
	syncSharedModelRuntimeCredentials(getDesktopModelCredentialStore(), readModelsConfigSync().providers);
	const runtime = createCodingAgentModelRuntime(authStorage, {
		modelsJsonPath: join(agentDir, "models.json"),
		configFileSource: nodeSyncTextFileSource,
		configurationValueResolver: nodeConfigurationValueResolver,
		validateModelAccess: async (model) => {
			const lease = await assertFlowstokenModelAccess(
				model.provider,
				model.id,
				managedGroupBindings[model.provider],
				model.modelId,
				{
					baseUrl: model.baseUrl,
					headers: model.headers,
				},
			);
			hydrateProviderCredential(model.provider);
			return lease;
		},
		validateProviderAccess: async (provider) => {
			const lease = await assertFlowstokenModelAccess(provider, undefined, managedGroupBindings[provider]);
			hydrateProviderCredential(provider);
			return lease;
		},
	});
	runtime.setServerUrl(DEFAULT_SERVER_URL);
	runtime.setServerToken(readServerTokenFromDisk());
	runtime.setServerTokenGetter(readServerTokenFromDisk);
	void runtime.loadRemoteModels();
	sharedModelRuntime = runtime;
	return runtime;
}

export function syncSharedModelRuntimeCredentials(
	credentials: ModelCredentialStore,
	providers: Record<string, RuntimeCredentialProvider>,
): void {
	const auth = sharedModelAuth;
	modelCredentials = credentials;
	credentialProviders = Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, { ...provider }]));
	managedGroupBindings = Object.fromEntries(
		Object.entries(providers).map(([id, provider]) => [id, provider.managedGroup]),
	);
	if (!auth) return;
	for (const providerId of syncedCredentialProviderIds) auth.removeRuntimeApiKey(providerId);
	syncedCredentialProviderIds = new Set();
	for (const [providerId, provider] of Object.entries(providers)) {
		if (isManagedCredentialProvider(provider)) injectProviderCredential(providerId, resolveManagedApiKey(provider));
		else if (provider.credentialRef) injectProviderCredential(providerId, credentials.peek?.(provider.credentialRef));
	}
}

export function readDesktopMcpDebug(cwd: string, agentDir: string): boolean {
	return SettingsRuntime.fromStorage(
		new NodeScopedTextStorage({
			global: join(agentDir, "settings.json"),
			project: resolveProjectSettingsPath(cwd, agentDir),
		}),
	).getMcpDebug();
}

function readServerTokenFromDisk(): string | undefined {
	const path = join(getAgentDir(), "settings.json");
	if (!existsSync(path)) return undefined;
	try {
		const settings = JSON.parse(readFileSync(path, "utf8")) as { serverToken?: string };
		return settings.serverToken;
	} catch {
		return undefined;
	}
}
