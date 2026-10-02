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
import { getDesktopModelCredentialStore, type ModelCredentialStore } from "../models/model-credential-store.js";
import { type ProviderConfig, readModelsConfigSync } from "../models/model-settings-service.js";

let sharedModelRuntime: CodingAgentModelRuntime | undefined;
let sharedModelAuth: CodingAgentAuthRuntime | undefined;
let syncedCredentialProviderIds = new Set<string>();
let managedGroupBindings: Readonly<Record<string, ProviderConfig["managedGroup"]>> = {};

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
		validateModelAccess: (model) =>
			assertFlowstokenModelAccess(model.provider, model.id, managedGroupBindings[model.provider], model.modelId, {
				baseUrl: model.baseUrl,
				headers: model.headers,
			}),
		validateProviderAccess: (provider) =>
			assertFlowstokenModelAccess(provider, undefined, managedGroupBindings[provider]),
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
	providers: Record<string, { credentialRef?: string; managedGroup?: ProviderConfig["managedGroup"] }>,
): void {
	const auth = sharedModelAuth;
	managedGroupBindings = Object.fromEntries(
		Object.entries(providers).map(([id, provider]) => [id, provider.managedGroup]),
	);
	if (!auth) return;
	const nextProviderIds = new Set<string>();
	for (const [providerId, provider] of Object.entries(providers)) {
		if (!provider.credentialRef) continue;
		const apiKey = credentials.get(provider.credentialRef);
		if (!apiKey) continue;
		auth.setRuntimeApiKey(providerId, apiKey);
		nextProviderIds.add(providerId);
	}
	for (const providerId of syncedCredentialProviderIds) {
		if (!nextProviderIds.has(providerId)) auth.removeRuntimeApiKey(providerId);
	}
	syncedCredentialProviderIds = nextProviderIds;
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
