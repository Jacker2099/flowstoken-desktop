import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getVettaHomePath } from "@vetta/action-rpc";
import { atomicWriteJSON } from "@vetta/toolkit/atomic-write";
import type {
	ModelConfigSnapshot,
	ModelDefaultResult,
	ModelDefinitionDetail,
	ModelListResult,
	ModelProviderConfigSnapshot,
	ModelProviderDetail,
	ModelProviderUpsertData,
} from "@vetta-org/capability-sdk";
import type { ModelsSetOptions } from "../../preload/api-types/models.js";
import { isManagedFlowstokenProviderId } from "../../shared/flowstoken-catalog-policy.js";
import { type ModelCredentialStore, ModelCredentialUnavailableError } from "./model-credential-store.js";

export interface ModelsConfig {
	defaultModel?: string;
	providers: Record<string, ProviderConfig>;
}

export interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	/** Opaque reference to an API key held by the desktop credential vault. */
	credentialRef?: string;
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	displayName?: string;
	source?: "template";
	templateId?: string;
	icon?: string;
	/** 预设服务商模型列表最近一次从上游 /models 同步的时间(ISO)。 */
	modelsSyncedAt?: string;
	catalogVersion?: string;
	/** Account ownership is bound by authenticated token provisioning, never by public catalog JSON. */
	managedGroup?: { source: "flowstoken"; groupId: string; accountId: number; tokenId: number };
	managedGroupOverride?: boolean;
	/**
	 * 该服务商的模型请求是否经应用代理出网。缺省(undefined)跟随全局，即代理
	 * 开启后默认走代理；显式 false 才排除。应用代理未启用时本字段无效。
	 */
	useProxy?: boolean;
	models?: ModelDefinition[];
	modelOverrides?: Record<string, Record<string, unknown>>;
}

export interface ModelDefinition {
	id: string;
	modelId?: string;
	name?: string;
	api?: string;
	reasoning?: boolean;
	reasoningLevels?: string[];
	defaultReasoningLevel?: string;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelSettingsServiceOptions {
	readonly readConfig: () => Promise<ModelsConfig>;
	readonly refreshRegistry: () => Promise<void>;
	readonly writeConfig: (config: ModelsConfig) => Promise<void>;
	readonly credentials: ModelCredentialStore;
	/** Authenticated session authority; managed keys never fall back to the persistent vault when installed. */
	readonly resolveManagedApiKey?: (provider: ProviderConfig) => string | undefined;
	/** Post-commit signal; observers must not receive credential values. */
	readonly onProviderAccessChanged?: (providerIds: readonly string[]) => void;
	/** Post-commit signal for model catalog consumers. */
	readonly onConfigChanged?: (providerIds: readonly string[]) => void;
}

const MODELS_CONFIG_PATH = join(getVettaHomePath(), "agent", "models.json");
const DEFAULT_MODELS_CONFIG: ModelsConfig = { providers: {} };
export const MASKED_MODEL_API_KEY = "***";

function stripLegacyPeripheralFields(config: ModelsConfig): ModelsConfig {
	const next = { ...config } as ModelsConfig & {
		peripheralModel?: unknown;
		peripheralModelReasoningLevel?: unknown;
	};
	delete next.peripheralModel;
	delete next.peripheralModelReasoningLevel;
	return next;
}

export function readModelsConfigSync(): ModelsConfig {
	try {
		const raw = readFileSync(MODELS_CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<ModelsConfig>;
		return stripLegacyPeripheralFields({
			...DEFAULT_MODELS_CONFIG,
			...parsed,
			providers:
				typeof parsed.providers === "object" && parsed.providers !== null && !Array.isArray(parsed.providers)
					? parsed.providers
					: {},
		});
	} catch {
		return { providers: {} };
	}
}

export async function readModelsConfig(): Promise<ModelsConfig> {
	return readModelsConfigSync();
}

export async function writeModelsConfig(config: ModelsConfig): Promise<void> {
	atomicWriteJSON(MODELS_CONFIG_PATH, stripLegacyPeripheralFields(config));
}

function maskSecret(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value.length === 0) return "";
	return MASKED_MODEL_API_KEY;
}

function redactRecordSecrets(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	const next: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		next[key] = isSecretHeaderKey(key) ? MASKED_MODEL_API_KEY : value;
	}
	return next;
}

function isSecretHeaderKey(key: string): boolean {
	const lower = key.toLowerCase();
	return ["authorization", "api-key", "apikey", "x-api-key", "token", "secret", "password", "cookie"].some((part) =>
		lower.includes(part),
	);
}

function restoreMaskedHeaders(provider: ProviderConfig, current: ProviderConfig | undefined): void {
	if (!provider.headers) return;
	for (const [key, value] of Object.entries(provider.headers)) {
		if (value !== MASKED_MODEL_API_KEY || !isSecretHeaderKey(key)) continue;
		const previous = Object.entries(current?.headers ?? {}).find(
			([oldKey]) => oldKey.toLowerCase() === key.toLowerCase(),
		);
		if (previous && previous[1] !== MASKED_MODEL_API_KEY) provider.headers[key] = previous[1];
		else delete provider.headers[key];
	}
}

function copyModel(model: ModelDefinition): ModelDefinitionDetail {
	return {
		id: model.id,
		...(model.modelId === undefined ? {} : { modelId: model.modelId }),
		...(model.name === undefined ? {} : { name: model.name }),
		...(model.api === undefined ? {} : { api: model.api }),
		...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
		...(model.reasoningLevels === undefined ? {} : { reasoningLevels: [...model.reasoningLevels] }),
		...(model.defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel: model.defaultReasoningLevel }),
		...(model.input === undefined ? {} : { input: [...model.input] }),
		...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
		...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
		...(model.cost === undefined ? {} : { cost: { ...model.cost } }),
	};
}

function redactProvider(provider: ProviderConfig): ModelProviderConfigSnapshot {
	const apiKey = maskSecret(provider.apiKey);
	const headers = redactRecordSecrets(provider.headers);
	return {
		...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
		...(apiKey === undefined ? {} : { apiKey }),
		...(provider.api === undefined ? {} : { api: provider.api }),
		...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
		...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
		...(provider.useProxy === undefined ? {} : { useProxy: provider.useProxy }),
		...(headers === undefined ? {} : { headers }),
		...(provider.models === undefined ? {} : { models: provider.models.map(copyModel) }),
	};
}

/** 空模型列表表示该 provider 不枚举模型，任何 id 都算存在（与 assertModelKeyExists 一致）。 */
function modelKeyExists(providers: Record<string, ProviderConfig>, modelKey: string): boolean {
	const slash = modelKey.indexOf("/");
	if (slash <= 0) return false;
	const provider = providers[modelKey.slice(0, slash)];
	if (!provider) return false;
	const models = provider.models ?? [];
	return models.length === 0 || models.some((model) => model.id === modelKey.slice(slash + 1));
}

function assertModelKeyExists(config: ModelsConfig, modelKey: string, operation: string): void {
	const slash = modelKey.indexOf("/");
	if (slash <= 0) {
		throw new Error(
			`Refused operation "${operation}": invalid modelKey=${JSON.stringify(modelKey)}. Expected "provider/modelId".`,
		);
	}
	const providerId = modelKey.slice(0, slash);
	const modelId = modelKey.slice(slash + 1);
	const provider = config.providers[providerId];
	if (!provider) {
		throw new Error(
			`Refused operation "${operation}": model provider ${JSON.stringify(providerId)} not found. Call models.query list.`,
		);
	}
	const models = provider.models ?? [];
	if (models.length > 0 && !models.some((model) => model.id === modelId)) {
		throw new Error(
			`Refused operation "${operation}": model ${JSON.stringify(modelKey)} not found on provider ${JSON.stringify(providerId)}.`,
		);
	}
}

function cloneModelsConfig(config: ModelsConfig): ModelsConfig {
	return {
		...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
		providers: Object.fromEntries(
			Object.entries(config.providers).map(([id, provider]) => [
				id,
				{
					...provider,
					...(provider.headers === undefined ? {} : { headers: { ...provider.headers } }),
					...(provider.models === undefined ? {} : { models: provider.models.map((model) => ({ ...model })) }),
					...(provider.modelOverrides === undefined
						? {}
						: {
								modelOverrides: Object.fromEntries(
									Object.entries(provider.modelOverrides).map(([modelId, value]) => [modelId, { ...value }]),
								),
							}),
				},
			]),
		),
	};
}

function normalizeExternalApiKeySource(value: string): string | undefined {
	const trimmed = value.trim();
	if (/^![\s\S]+/.test(trimmed)) return trimmed;
	const envMatch = /^env:([A-Z_][A-Z0-9_]*)$/i.exec(trimmed);
	if (envMatch?.[1]) return envMatch[1];
	const commandMatch = /^cmd:([\s\S]+)$/i.exec(trimmed);
	if (commandMatch?.[1]) return `!${commandMatch[1]}`;
	if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) return trimmed;
	return undefined;
}

function rendererConfig(config: ModelsConfig): ModelsConfig {
	const next = cloneModelsConfig(config);
	for (const provider of Object.values(next.providers)) {
		if (provider.credentialRef || (provider.apiKey && !normalizeExternalApiKeySource(provider.apiKey))) {
			provider.apiKey = MASKED_MODEL_API_KEY;
		}
		provider.headers = redactRecordSecrets(provider.headers);
	}
	return next;
}

type PersistInputMode = "renderer" | "resolved";

export class ModelSettingsService {
	private mutationQueue: Promise<void> = Promise.resolve();
	private legacyMigration: Promise<void> | undefined;

	constructor(private readonly options: ModelSettingsServiceOptions) {}

	async getConfig(): Promise<ModelsConfig> {
		await this.mutationQueue;
		await this.ensureLegacyCredentialsMigrated();
		return this.resolveCredentials(await this.options.readConfig());
	}

	async getRendererConfig(): Promise<ModelsConfig> {
		return this.getMetadataConfig();
	}

	/** Read model metadata without decrypting or migrating unrelated persistent credentials. */
	async getMetadataConfig(): Promise<ModelsConfig> {
		return this.readRendererSnapshot((config) => config);
	}

	/** Read and synchronously project a secret-free snapshot on the existing configuration queue. */
	async readRendererSnapshot<Result>(read: (config: ModelsConfig) => Result): Promise<Result> {
		return this.runMutation(async () => {
			const persisted = await this.options.readConfig();
			const result = read(this.projectMetadata(persisted));
			if (result !== null && typeof result === "object" && "then" in result && typeof result.then === "function") {
				throw new TypeError("A renderer snapshot projection must be synchronous");
			}
			return result;
		});
	}

	/** Main-process only. IPC callers must not return this value to the renderer. */
	async getProviderApiKey(providerId: string): Promise<string | undefined> {
		await this.mutationQueue;
		const provider = (await this.options.readConfig()).providers[providerId];
		if (!provider) return undefined;
		if (this.usesManagedSessionCredentials(provider)) return this.options.resolveManagedApiKey?.(provider);
		if (provider.apiKey !== undefined) return provider.apiKey;
		return provider.credentialRef ? this.options.credentials.get(provider.credentialRef) : undefined;
	}

	/** Background metadata work may reuse an already authorized key, but must never unlock the vault. */
	async getCachedProviderApiKey(providerId: string): Promise<string | undefined> {
		await this.mutationQueue;
		const provider = (await this.options.readConfig()).providers[providerId];
		if (!provider) return undefined;
		if (this.usesManagedSessionCredentials(provider)) return this.options.resolveManagedApiKey?.(provider);
		return provider.credentialRef ? this.options.credentials.peek?.(provider.credentialRef) : provider.apiKey;
	}

	async replaceConfig(config: ModelsConfig, options?: ModelsSetOptions): Promise<void> {
		await this.runMutation(async () => {
			if (options?.renameProvider) {
				await this.renameProvider(config, options.renameProvider);
				return;
			}
			await this.ensureLegacyCredentialsMigrated();
			await this.persist(config, await this.options.readConfig(), "renderer");
		});
	}

	private async renameProvider(
		config: ModelsConfig,
		rename: NonNullable<ModelsSetOptions["renameProvider"]>,
	): Promise<void> {
		const { from, to } = rename;
		if (
			!from ||
			!to ||
			from === to ||
			to !== to.trim() ||
			/[\\/\u0000-\u001f\u007f]/.test(to) ||
			["__proto__", "constructor", "prototype"].includes(to)
		)
			throw new Error("MODEL_PROVIDER_RENAME_INVALID");
		const current = await this.options.readConfig();
		const previous = current.providers[from];
		const requested = config.providers[to];
		if (
			!Object.hasOwn(current.providers, from) ||
			!Object.hasOwn(config.providers, to) ||
			!previous ||
			!requested ||
			previous.source === "template" ||
			previous.managedGroup ||
			Boolean(isManagedFlowstokenProviderId(from)) ||
			Boolean(isManagedFlowstokenProviderId(to))
		)
			throw new Error("MODEL_PROVIDER_RENAME_UNAVAILABLE");
		if (Object.hasOwn(current.providers, to)) throw new Error("MODEL_PROVIDER_RENAME_CONFLICT");

		// Resolve masks against the explicit source identity, never infer it from key or header values.
		// Rebase only provider-editor fields so catalog updates and other providers are not overwritten.
		const edited = { ...previous };
		for (const field of ["baseUrl", "apiKey", "api", "headers", "authHeader"] as const) {
			if (!Object.hasOwn(requested, field)) continue;
			Object.assign(edited, { [field]: requested[field] });
		}
		const baseline = { ...current, providers: { ...current.providers, [to]: previous } };
		delete baseline.providers[from];
		const next = {
			...baseline,
			defaultModel: current.defaultModel?.startsWith(`${from}/`)
				? `${to}${current.defaultModel.slice(from.length)}`
				: current.defaultModel,
			providers: { ...baseline.providers, [to]: edited },
		};
		await this.persist(next, baseline, "renderer", undefined, true, current);
	}

	/** Main-process updates read and commit under the same queue; the guard runs before credential writes. */
	async updateConfig(
		update: (current: ModelsConfig) => ModelsConfig | undefined,
		beforeCommit?: () => void,
	): Promise<void> {
		await this.runMutation(async () => {
			await this.ensureLegacyCredentialsMigrated();
			const current = await this.options.readConfig();
			beforeCommit?.();
			const next = update(this.resolveCredentials(current));
			if (next) await this.persist(next, current, "resolved", beforeCommit);
		});
	}

	/** Display/catalog updates round-trip opaque keys without migrating unrelated legacy plaintext. */
	async updateMetadataConfig(
		update: (current: ModelsConfig) => ModelsConfig | undefined,
		beforeCommit?: () => void,
	): Promise<void> {
		await this.runMutation(async () => {
			const current = await this.options.readConfig();
			beforeCommit?.();
			const next = update(this.projectMetadata(current));
			if (next) await this.persist(next, current, "renderer", beforeCommit, true);
		});
	}

	async list(): Promise<ModelListResult> {
		const config = await this.getMetadataConfig();
		return {
			defaultModel: config.defaultModel ?? null,
			providers: Object.entries(config.providers).map(([id, provider]) => ({
				id,
				displayName: provider.displayName ?? id,
				...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
				...(provider.api === undefined ? {} : { api: provider.api }),
				hasApiKey: Boolean(provider.apiKey),
				...(provider.icon === undefined ? {} : { icon: provider.icon }),
				modelCount: provider.models?.length ?? 0,
				models: (provider.models ?? []).map((model) => ({
					id: model.id,
					...(model.name === undefined ? {} : { name: model.name }),
					...(model.api === undefined ? {} : { api: model.api }),
					...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
				})),
			})),
		};
	}

	async getSanitizedConfig(): Promise<ModelConfigSnapshot> {
		const config = await this.getMetadataConfig();
		const providers: Record<string, ModelProviderConfigSnapshot> = {};
		for (const [id, provider] of Object.entries(config.providers)) providers[id] = redactProvider(provider);
		return {
			...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
			providers,
		};
	}

	async getSanitizedProvider(providerId: string): Promise<ModelProviderDetail> {
		const config = await this.getMetadataConfig();
		const provider = config.providers[providerId];
		if (!provider) throw new Error(`Provider not found: ${providerId}`);
		return { provider: providerId, ...redactProvider(provider) };
	}

	async validateModelKey(modelKey: string, operation = "set-default"): Promise<void> {
		assertModelKeyExists(await this.getMetadataConfig(), modelKey, operation);
	}

	async setDefault(modelKey: string): Promise<ModelDefaultResult> {
		await this.updateMetadataConfig((config) => {
			assertModelKeyExists(config, modelKey, "set-default");
			return { ...config, defaultModel: modelKey };
		});
		return { defaultModel: modelKey };
	}

	async upsertProvider(providerId: string, data: ModelProviderUpsertData): Promise<ModelProviderConfigSnapshot> {
		return this.runMutation(async () => {
			await this.ensureLegacyCredentialsMigrated();
			const config = await this.options.readConfig();
			const existing = config.providers[providerId] ?? {};
			const next: ProviderConfig = { ...existing };
			if (data.baseUrl !== undefined) next.baseUrl = data.baseUrl;
			if (data.apiKey !== undefined) next.apiKey = data.apiKey;
			if (data.api !== undefined) next.api = data.api;
			if (data.displayName !== undefined) next.displayName = data.displayName;
			if (data.authHeader !== undefined) next.authHeader = data.authHeader;
			if (data.useProxy !== undefined) next.useProxy = data.useProxy;
			if (data.headers !== undefined) next.headers = { ...data.headers };
			if (data.models !== undefined) next.models = data.models.map((model) => ({ ...model }));
			const persisted = await this.persist(
				{ ...config, providers: { ...config.providers, [providerId]: next } },
				config,
				"resolved",
			);
			return redactProvider(this.resolveProvider(persisted.providers[providerId] ?? {}));
		});
	}

	async removeProvider(providerId: string): Promise<void> {
		await this.runMutation(async () => {
			await this.ensureLegacyCredentialsMigrated();
			const config = await this.options.readConfig();
			if (!config.providers[providerId]) return;
			const providers = { ...config.providers };
			delete providers[providerId];
			const next = { ...config, providers };
			if (next.defaultModel?.startsWith(`${providerId}/`)) delete next.defaultModel;
			await this.persist(next, config, "resolved");
		});
	}

	async replaceOwnedProviders(owner: string, providers: Record<string, ModelProviderUpsertData>): Promise<void> {
		const prefix = `${owner}.`;
		await this.runMutation(async () => {
			await this.ensureLegacyCredentialsMigrated();
			const config = await this.options.readConfig();
			const nextProviders: Record<string, ProviderConfig> = {};
			for (const [providerId, provider] of Object.entries(config.providers)) {
				if (!providerId.startsWith(prefix)) nextProviders[providerId] = provider;
			}
			for (const [localProviderId, data] of Object.entries(providers)) {
				const providerId = `${owner}.${localProviderId}`;
				if (!providerId.startsWith(prefix)) throw new Error("Owned provider escaped its plugin namespace");
				nextProviders[providerId] = {
					...(data.baseUrl === undefined ? {} : { baseUrl: data.baseUrl }),
					...(data.apiKey === undefined ? {} : { apiKey: data.apiKey }),
					...(data.api === undefined ? {} : { api: data.api }),
					...(data.displayName === undefined ? {} : { displayName: data.displayName }),
					...(data.authHeader === undefined ? {} : { authHeader: data.authHeader }),
					...(data.headers === undefined ? {} : { headers: { ...data.headers } }),
					...(data.models === undefined ? {} : { models: data.models.map((model) => ({ ...model })) }),
				};
			}
			const next = { ...config, providers: nextProviders };
			// 只在默认模型确实随本次替换消失时才清除。插件几乎每次刷新都会重发同一批
			// 模型，无条件清除会让用户选中的默认模型在每次重启后被悄悄重置。
			if (next.defaultModel?.startsWith(prefix) && !modelKeyExists(nextProviders, next.defaultModel)) {
				delete next.defaultModel;
			}
			await this.persist(next, config, "resolved");
		});
	}

	/**
	 * 插件读回自己已发布的 providers，键为去掉 `<owner>.` 前缀的局部 id。
	 *
	 * 没有读回能力，插件每次写入都只能从零重建「全部真相」；而它的上游数据源往往
	 * 是最终一致的，于是「这一次还没读到」会被写成「用户没有这个模型了」。能读回，
	 * 插件才能做增量对账——让删除必须有正向证据，而不是靠时序运气。
	 */
	async listOwnedProviders(owner: string): Promise<Record<string, ModelProviderConfigSnapshot>> {
		const prefix = `${owner}.`;
		const config = await this.getMetadataConfig();
		return Object.fromEntries(
			Object.entries(config.providers)
				.filter(([providerId]) => providerId.startsWith(prefix))
				.map(([providerId, provider]) => [providerId.slice(prefix.length), redactProvider(provider)]),
		);
	}

	private async persist(
		config: ModelsConfig,
		current: ModelsConfig,
		mode: PersistInputMode,
		beforeCommit?: () => void,
		metadataOnly = false,
		rollbackConfigOnFailure?: ModelsConfig,
	): Promise<ModelsConfig> {
		const persisted = cloneModelsConfig(config);
		const writes = new Map<string, string>();
		const nextRefs = new Map<string, string>();
		const credentialWriteProviders = new Set<string>();

		for (const [providerId, provider] of Object.entries(persisted.providers)) {
			const currentProvider = current.providers[providerId];
			if (mode === "renderer") restoreMaskedHeaders(provider, currentProvider);
			const value = provider.apiKey;
			let currentRef = provider.credentialRef ?? currentProvider?.credentialRef;
			const currentUsesSession = this.usesManagedSessionCredentials(currentProvider);
			if (!beforeCommit) {
				delete provider.managedGroup;
				provider.managedGroupOverride = currentProvider?.managedGroupOverride;
				const binding = currentProvider?.managedGroup;
				if (binding) {
					const unchangedMaskedCredential =
						value === MASKED_MODEL_API_KEY && currentRef === currentProvider.credentialRef;
					const currentKey = currentUsesSession
						? this.options.resolveManagedApiKey?.(currentProvider)
						: unchangedMaskedCredential
							? MASKED_MODEL_API_KEY
							: currentProvider.credentialRef
								? this.options.credentials.get(currentProvider.credentialRef)
								: currentProvider.apiKey;
					const nextKey =
						value === MASKED_MODEL_API_KEY
							? currentUsesSession || unchangedMaskedCredential
								? currentKey
								: currentRef
									? this.options.credentials.get(currentRef)
									: currentKey
							: value === undefined && mode === "resolved"
								? currentKey
								: value;
					if (
						nextKey === currentKey &&
						provider.baseUrl === currentProvider.baseUrl &&
						currentRef === currentProvider.credentialRef
					)
						provider.managedGroup = binding;
					else provider.managedGroupOverride = true;
				}
			} else if (provider.managedGroup) delete provider.managedGroupOverride;

			if (this.usesManagedSessionCredentials(provider)) {
				delete provider.apiKey;
				if (currentProvider?.credentialRef) {
					provider.credentialRef = currentProvider.credentialRef;
					this.registerCredentialRef(nextRefs, provider.credentialRef, providerId);
				} else delete provider.credentialRef;
				if (value !== undefined && value !== MASKED_MODEL_API_KEY) credentialWriteProviders.add(providerId);
				continue;
			}
			// An explicit personal override gets a new persistent key. Never overwrite the
			// old managed ciphertext, which may belong to an inaccessible keychain.
			if (currentUsesSession) {
				currentRef = undefined;
				delete provider.credentialRef;
				if (value === MASKED_MODEL_API_KEY) {
					delete provider.apiKey;
					continue;
				}
			}

			if (
				metadataOnly &&
				!currentUsesSession &&
				currentProvider &&
				currentRef === currentProvider.credentialRef &&
				(value === MASKED_MODEL_API_KEY ||
					(value !== undefined && value === currentProvider.apiKey && normalizeExternalApiKeySource(value)))
			) {
				// Metadata consumers receive an opaque projection, not permission to
				// normalize a legacy custom credential (including interrupted migration state).
				if (currentProvider.apiKey === undefined) delete provider.apiKey;
				else provider.apiKey = currentProvider.apiKey;
				if (currentRef) {
					provider.credentialRef = currentRef;
					this.registerCredentialRef(nextRefs, currentRef, providerId);
				} else delete provider.credentialRef;
				continue;
			}

			if (mode === "renderer" && value === MASKED_MODEL_API_KEY) {
				if (currentRef) {
					provider.credentialRef = currentRef;
					delete provider.apiKey;
					this.registerCredentialRef(nextRefs, currentRef, providerId);
				} else if (currentProvider?.apiKey) {
					provider.apiKey = currentProvider.apiKey;
				} else {
					delete provider.apiKey;
				}
				continue;
			}

			if (value === undefined) {
				if (mode === "resolved" && currentRef) {
					provider.credentialRef = currentRef;
					this.registerCredentialRef(nextRefs, currentRef, providerId);
				} else {
					delete provider.credentialRef;
				}
				continue;
			}

			const externalSource = normalizeExternalApiKeySource(value);
			if (externalSource) {
				provider.apiKey = externalSource;
				delete provider.credentialRef;
				continue;
			}

			if (!this.options.credentials.isAvailable() && !currentRef && currentProvider?.apiKey === value) {
				provider.apiKey = value;
				continue;
			}

			const credentialRef = currentRef ?? randomUUID();
			provider.credentialRef = credentialRef;
			delete provider.apiKey;
			writes.set(credentialRef, value);
			credentialWriteProviders.add(providerId);
			this.registerCredentialRef(nextRefs, credentialRef, providerId);
		}

		const currentRefs = new Set(
			Object.values(current.providers)
				.filter((provider) => !this.usesManagedSessionCredentials(provider))
				.map((provider) => provider.credentialRef)
				.filter((value): value is string => Boolean(value)),
		);
		const removals = [...currentRefs].filter((credentialRef) => !nextRefs.has(credentialRef));
		const affectedRefs = new Set([...writes.keys(), ...removals]);
		const snapshots = new Map<string, () => void>();
		for (const credentialRef of affectedRefs) {
			snapshots.set(credentialRef, this.createCredentialRestorePoint(credentialRef));
		}

		beforeCommit?.();
		let configWritten = false;
		let registryRefreshStarted = false;
		try {
			for (const [credentialRef, value] of writes) this.options.credentials.set(credentialRef, value);
			for (const credentialRef of removals) this.options.credentials.remove(credentialRef);
			await this.options.writeConfig(persisted);
			configWritten = true;
			beforeCommit?.();
			registryRefreshStarted = true;
			await this.options.refreshRegistry();
			beforeCommit?.();
		} catch (error) {
			let canceled = false;
			try {
				beforeCommit?.();
			} catch {
				canceled = true;
			}
			if (!configWritten || canceled || rollbackConfigOnFailure) this.restoreCredentials(snapshots);
			if (configWritten && (canceled || rollbackConfigOnFailure)) {
				await this.options.writeConfig(rollbackConfigOnFailure ?? current);
				if (registryRefreshStarted) await this.options.refreshRegistry();
			}
			throw error;
		}
		const accessChangedProviders = Object.keys(persisted.providers).filter(
			(providerId) =>
				credentialWriteProviders.has(providerId) ||
				!sameProviderAccess(current.providers[providerId], persisted.providers[providerId]),
		);
		if (accessChangedProviders.length > 0) this.notifyProviderAccessChanged(accessChangedProviders);
		this.options.onConfigChanged?.(Object.keys(persisted.providers));
		return persisted;
	}

	private projectMetadata(config: ModelsConfig): ModelsConfig {
		const projected = rendererConfig(config);
		for (const [providerId, provider] of Object.entries(config.providers)) {
			if (!this.usesManagedSessionCredentials(provider)) continue;
			if (this.options.resolveManagedApiKey?.(provider) !== undefined)
				projected.providers[providerId].apiKey = MASKED_MODEL_API_KEY;
			else delete projected.providers[providerId].apiKey;
		}
		return projected;
	}

	private resolveCredentials(config: ModelsConfig): ModelsConfig {
		const resolved = cloneModelsConfig(config);
		for (const provider of Object.values(resolved.providers)) {
			if (this.usesManagedSessionCredentials(provider)) {
				delete provider.apiKey;
				const apiKey = this.options.resolveManagedApiKey?.(provider);
				if (apiKey !== undefined) provider.apiKey = apiKey;
				continue;
			}
			if (!provider.credentialRef) continue;
			const apiKey = this.options.credentials.get(provider.credentialRef);
			if (apiKey !== undefined) provider.apiKey = apiKey;
		}
		return resolved;
	}

	private resolveProvider(provider: ProviderConfig): ProviderConfig {
		if (this.usesManagedSessionCredentials(provider)) {
			const { apiKey: _persistedApiKey, ...persisted } = provider;
			const apiKey = this.options.resolveManagedApiKey?.(provider);
			return { ...persisted, ...(apiKey === undefined ? {} : { apiKey }) };
		}
		if (!provider.credentialRef) return { ...provider };
		const apiKey = this.options.credentials.get(provider.credentialRef);
		return { ...provider, ...(apiKey === undefined ? {} : { apiKey }) };
	}

	private ensureLegacyCredentialsMigrated(): Promise<void> {
		if (this.legacyMigration) return this.legacyMigration;
		const migration = this.migrateLegacyCredentials()
			.then((completed) => {
				if (!completed && this.legacyMigration === migration) this.legacyMigration = undefined;
			})
			.catch((error) => {
				if (this.legacyMigration === migration) this.legacyMigration = undefined;
				throw error;
			});
		this.legacyMigration = migration;
		return this.legacyMigration;
	}

	private async migrateLegacyCredentials(): Promise<boolean> {
		const config = await this.options.readConfig();
		const requiresEncryption = Object.values(config.providers).some(
			(provider) =>
				!this.usesManagedSessionCredentials(provider) &&
				typeof provider.apiKey === "string" &&
				provider.apiKey.length > 0 &&
				!normalizeExternalApiKeySource(provider.apiKey),
		);
		if (requiresEncryption && !this.options.credentials.isAvailable()) return false;
		const migrated = cloneModelsConfig(config);
		const snapshots = new Map<string, () => void>();
		let changed = false;
		const changedProviderIds: string[] = [];
		try {
			for (const [providerId, provider] of Object.entries(migrated.providers)) {
				if (this.usesManagedSessionCredentials(provider)) continue;
				if (!provider.apiKey) continue;
				const externalSource = normalizeExternalApiKeySource(provider.apiKey);
				if (externalSource) {
					if (provider.apiKey !== externalSource || provider.credentialRef !== undefined) changed = true;
					provider.apiKey = externalSource;
					delete provider.credentialRef;
					continue;
				}
				const credentialRef = provider.credentialRef ?? randomUUID();
				snapshots.set(credentialRef, this.createCredentialRestorePoint(credentialRef));
				this.options.credentials.set(credentialRef, provider.apiKey);
				provider.credentialRef = credentialRef;
				delete provider.apiKey;
				changed = true;
				changedProviderIds.push(providerId);
			}
			if (!changed) return true;
			await this.options.writeConfig(migrated);
		} catch (error) {
			this.restoreCredentials(snapshots);
			throw error;
		}
		await this.options.refreshRegistry();
		this.notifyProviderAccessChanged(changedProviderIds);
		return true;
	}

	private usesManagedSessionCredentials(provider: ProviderConfig | undefined): boolean {
		return Boolean(
			this.options.resolveManagedApiKey &&
				provider?.managedGroup?.source === "flowstoken" &&
				!provider.managedGroupOverride,
		);
	}

	private notifyProviderAccessChanged(providerIds: readonly string[]): void {
		try {
			this.options.onProviderAccessChanged?.(providerIds);
		} catch {
			// Configuration is already committed; an optional wake-up observer cannot roll it back.
		}
	}

	private registerCredentialRef(refs: Map<string, string>, credentialRef: string, providerId: string): void {
		const duplicateOwner = refs.get(credentialRef);
		if (duplicateOwner && duplicateOwner !== providerId) {
			throw new Error("A model credential cannot be shared by multiple providers");
		}
		refs.set(credentialRef, providerId);
	}

	private createCredentialRestorePoint(credentialRef: string): () => void {
		const credentials = this.options.credentials;
		if (credentials.createRestorePoint) return credentials.createRestorePoint(credentialRef);
		const existed = credentials.has(credentialRef);
		const previous = credentials.get(credentialRef);
		if (existed && previous === undefined) throw new ModelCredentialUnavailableError();
		return () => {
			if (previous === undefined) credentials.remove(credentialRef);
			else credentials.set(credentialRef, previous);
		};
	}

	private restoreCredentials(snapshots: ReadonlyMap<string, () => void>): void {
		for (const restore of snapshots.values()) {
			try {
				restore();
			} catch {
				// Preserve the original persistence error. A later migration can reconcile orphaned encrypted records.
			}
		}
	}

	private runMutation<Result>(mutation: () => Promise<Result>): Promise<Result> {
		const result = this.mutationQueue.then(mutation, mutation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function sameProviderAccess(left: ProviderConfig | undefined, right: ProviderConfig | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.baseUrl === right.baseUrl &&
		left.apiKey === right.apiKey &&
		left.credentialRef === right.credentialRef &&
		left.api === right.api &&
		left.authHeader === right.authHeader &&
		sameStringRecord(left.headers, right.headers)
	);
}

function sameStringRecord(
	left: Readonly<Record<string, string>> | undefined,
	right: Readonly<Record<string, string>> | undefined,
): boolean {
	const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	return (
		leftEntries.length === rightEntries.length &&
		leftEntries.every(([key, value], index) => key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1])
	);
}
