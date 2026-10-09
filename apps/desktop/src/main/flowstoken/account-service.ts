import { mainT } from "../i18n/index.js";
import { getDesktopModelSettingsService } from "../models/model-settings-host.js";
import type { ModelDefinition, ModelsConfig } from "../models/model-settings-service.js";
import { cancelSystemBrowserLogin, loginViaSystemBrowser } from "./browser-auth.js";
import { getAuthenticatedCatalogAccess, rememberVerifiedGroupKey } from "./catalog-access.js";
import {
	FLOWSTOKEN_CONSOLE_URL,
	FLOWSTOKEN_OPENAI_BASE_URL,
	FLOWSTOKEN_QUOTA_PER_USD,
	FLOWSTOKEN_SITE_URL,
	FLOWSTOKEN_TOPUP_URL,
} from "./constants.js";
import {
	catalogGroupModels,
	fallbackCatalog,
	fetchCatalog,
	GROUP_MODELS_MAX_AGE_MS,
	getCatalog,
	isValidBillingGroupId,
	peekCachedCatalog,
} from "./group-catalog.js";
import {
	clearFlowstokenSession,
	getFlowstokenSession,
	getFlowstokenSessionProbeError,
	loginWithPasswordAndTurnstile,
	probeExistingSession,
} from "./login-window.js";
import {
	createToken,
	FlowstokenApiError,
	fetchSelf,
	fetchSelfLogs,
	findManagedToken,
	getCachedAccessToken,
	getFlowstokenAccountId,
	getFlowstokenAuthRevision,
	listTokens,
	managedTokenName,
	revealTokenKey,
} from "./newapi-client.js";
import type {
	FlowstokenAccountSnapshot,
	FlowstokenCatalog,
	FlowstokenCatalogModel,
	FlowstokenEnsureKeysResult,
	FlowstokenGroupKeyState,
	FlowstokenLoginResult,
	FlowstokenUserSnapshot,
} from "./types.js";

function usd(quota: number): string {
	const value = quota / FLOWSTOKEN_QUOTA_PER_USD;
	return `$${value.toFixed(value >= 100 ? 2 : 4)}`;
}

function signedOutSnapshot(lastError?: string): FlowstokenAccountSnapshot {
	return {
		loggedIn: false,
		user: null,
		balanceUsd: "$0.0000",
		usedUsd: "$0.0000",
		groups: [],
		usage: [],
		siteUrl: FLOWSTOKEN_SITE_URL,
		topupUrl: FLOWSTOKEN_TOPUP_URL,
		consoleUrl: FLOWSTOKEN_CONSOLE_URL,
		lastError,
		updatedAt: Date.now(),
	};
}

async function groupStates(
	catalog: FlowstokenCatalog,
	accountId: number,
	allowed: ReadonlySet<string>,
): Promise<FlowstokenGroupKeyState[]> {
	const config = await getDesktopModelSettingsService().getMetadataConfig();
	let tokens: Awaited<ReturnType<typeof listTokens>> = [];
	try {
		tokens = await listTokens(getFlowstokenSession());
	} catch {
		tokens = [];
	}
	return catalog.groups.map((group) => {
		const managed = findManagedToken(tokens, group.id);
		const provider = config.providers[group.providerId];
		const wired = Boolean(
			provider?.apiKey &&
				provider.managedGroup?.source === "flowstoken" &&
				provider.managedGroup.accountId === accountId &&
				provider.managedGroup.groupId === group.id,
		);
		return {
			groupId: group.id,
			providerId: group.providerId,
			labelZh: group.title,
			tokenName: managedTokenName(group.id),
			tokenId: managed?.id,
			wired,
			enabled: allowed.has(group.id),
			requiresManualSetup: provider?.managedGroupOverride === true,
		};
	});
}

type SnapshotListener = (snapshot: FlowstokenAccountSnapshot) => void;
let snapshotBroadcastListener: SnapshotListener | null = null;

export function setSnapshotBroadcastListener(listener: SnapshotListener): void {
	snapshotBroadcastListener = listener;
}

function broadcastSnapshot(snapshot: FlowstokenAccountSnapshot): void {
	if (snapshotBroadcastListener) {
		try {
			snapshotBroadcastListener(snapshot);
		} catch {
			// Non-blocking
		}
	}
}

let autoSyncPromise: Promise<void> | null = null;
const MAX_AUTOMATIC_KEY_ATTEMPTS = 3;
const KEY_RETRY_BASE_DELAY_MS = 60_000;
let keySyncFailure: { revision: number; message: string; failures: number; retryAt: number | null } | null = null;

function currentKeySyncError(): string | undefined {
	return keySyncFailure?.revision === getFlowstokenAuthRevision() ? keySyncFailure.message : undefined;
}

function automaticKeySyncAllowed(): boolean {
	const failure = keySyncFailure;
	if (!failure || failure.revision !== getFlowstokenAuthRevision()) return true;
	return failure.retryAt !== null && Date.now() >= failure.retryAt;
}

function keyRetryDelay(error: unknown, failures: number): number | null {
	if (failures >= MAX_AUTOMATIC_KEY_ATTEMPTS) return null;
	const conservativeDelay = Math.min(5 * KEY_RETRY_BASE_DELAY_MS, KEY_RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
	if (error instanceof FlowstokenApiError) {
		if (
			error.status !== 429 &&
			!(error.status !== undefined && error.status >= 500 && error.status <= 599) &&
			!(error.status === undefined && error.retryAfterMs !== undefined)
		)
			return null;
		const requestedDelay =
			error.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
		return Math.max(conservativeDelay, requestedDelay);
	}
	return error instanceof TypeError &&
		/fetch|network|connection|socket|ECONN|ENOTFOUND|load failed/i.test(error.message)
		? conservativeDelay
		: null;
}

function triggerBackgroundSyncIfUnwired(user: FlowstokenUserSnapshot | null, groups: FlowstokenGroupKeyState[]): void {
	if (!user || !automaticKeySyncAllowed()) return;
	if (!groups.some((group) => group.enabled && !group.wired && !group.requiresManualSetup)) return;
	if (autoSyncPromise) return;

	autoSyncPromise = (async () => {
		try {
			const res = await queueGroupKeys(undefined, {}, true);
			if (res.snapshot) {
				broadcastSnapshot(res.snapshot);
			}
		} catch (e) {
			console.warn("[FlowsToken] Auto-sync unwired keys in background failed:", e);
		} finally {
			autoSyncPromise = null;
		}
	})();
}

export async function getAccountSnapshot(options?: {
	includeUsage?: boolean;
	lastError?: string;
}): Promise<FlowstokenAccountSnapshot> {
	const revision = getFlowstokenAuthRevision();
	const includeUsage = options?.includeUsage ?? true;
	const user = await probeExistingSession();
	if (!user) {
		if (getFlowstokenAccountId() !== null || getCachedAccessToken() !== null) assertAccountRevision(revision);
		return {
			loggedIn: false,
			user: null,
			balanceUsd: "$0.0000",
			usedUsd: "$0.0000",
			groups: [],
			usage: [],
			siteUrl: FLOWSTOKEN_SITE_URL,
			topupUrl: FLOWSTOKEN_TOPUP_URL,
			consoleUrl: FLOWSTOKEN_CONSOLE_URL,
			lastError: options?.lastError,
			updatedAt: Date.now(),
		};
	}
	assertAccountRevision(revision);
	let usage: FlowstokenAccountSnapshot["usage"] = [];
	if (includeUsage) {
		try {
			usage = await fetchSelfLogs(getFlowstokenSession(), 25);
		} catch {
			usage = [];
		}
	}

	const catalog = await getCatalog();
	let allowed: ReadonlySet<string> = new Set();
	let permissionError: string | undefined;
	try {
		const access = await getAuthenticatedCatalogAccess();
		if (access.accountId !== user.id) throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
		allowed = access.groups;
	} catch (error) {
		permissionError = error instanceof Error ? error.message : String(error);
	}
	const groups = await groupStates(catalog, user.id, allowed);
	assertAccountRevision(revision);
	triggerBackgroundSyncIfUnwired(user, groups);
	triggerBackgroundModelRefreshIfStale(groups);

	return {
		loggedIn: true,
		user,
		balanceUsd: usd(user.quota),
		usedUsd: usd(user.usedQuota),
		groups,
		usage,
		siteUrl: FLOWSTOKEN_SITE_URL,
		topupUrl: FLOWSTOKEN_TOPUP_URL,
		consoleUrl: FLOWSTOKEN_CONSOLE_URL,
		lastError:
			options?.lastError ??
			getFlowstokenSessionProbeError() ??
			permissionError ??
			currentKeySyncError() ??
			(groups.some((group) => group.requiresManualSetup) ? mainT("flowstoken.errors.credentialStale") : undefined),
		updatedAt: Date.now(),
	};
}

function toProviderModels(models: readonly FlowstokenCatalogModel[], existing: readonly ModelDefinition[] = []) {
	const byId = new Map(existing.map((model) => [model.id, model]));
	return models.filter(isChatModel).map((model) => {
		const previous = byId.get(model.id);
		const levels = model.reasoningLevels ?? previous?.reasoningLevels;
		const previousDefault = previous?.defaultReasoningLevel;
		const defaultReasoningLevel =
			previousDefault && (!levels || levels.includes(previousDefault))
				? previousDefault
				: model.defaultReasoningLevel;
		return {
			...previous,
			id: model.id,
			name: model.name,
			api: previous?.api ?? "openai-completions",
			input: previous?.input ?? (model.vision ? ["text", "image"] : ["text"]),
			// 目录是托管模型规格的权威来源：服务端下发值必须覆盖本地旧值，
			// 只在目录未给出时保留本地兜底（旧目录版本/规格暂缺）。
			...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
			...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
			...(levels?.length === 0
				? { reasoning: false }
				: previous?.reasoning !== undefined || model.reasoning === undefined
					? {}
					: { reasoning: model.reasoning }),
			...(levels === undefined ? {} : { reasoningLevels: levels, defaultReasoningLevel }),
		};
	});
}

function isChatModel(model: FlowstokenCatalogModel): boolean {
	return model.kind ? model.kind === "chat" : !model.image;
}

async function wireAllProviders(
	items: Array<{
		providerId: string;
		labelZh: string;
		apiKey: string;
		groupId: string;
		tokenId: number;
		models: readonly FlowstokenCatalogModel[];
	}>,
	defaultModelKey: string | undefined,
	revision: number,
	accountId: number,
): Promise<void> {
	const service = getDesktopModelSettingsService();
	await service.updateMetadataConfig(
		(config) => {
			const nextProviders = { ...config.providers };
			for (const item of items) {
				const existing = nextProviders[item.providerId];
				nextProviders[item.providerId] = {
					...existing,
					source: "template",
					templateId: item.providerId,
					displayName: `FlowsToken ${item.labelZh}`,
					icon: "openai",
					api: "openai-completions",
					baseUrl: FLOWSTOKEN_OPENAI_BASE_URL,
					apiKey: item.apiKey,
					managedGroup: { source: "flowstoken", groupId: item.groupId, tokenId: item.tokenId, accountId },
					models: toProviderModels(item.models, existing?.models),
					modelsSyncedAt: new Date().toISOString(),
				};
				if (
					item.groupId === "default" &&
					nextProviders["flowstoken-normal"]?.baseUrl === FLOWSTOKEN_OPENAI_BASE_URL
				) {
					const legacy = nextProviders["flowstoken-normal"];
					nextProviders["flowstoken-normal"] = {
						...legacy,
						apiKey: item.apiKey,
						managedGroup: { source: "flowstoken", groupId: item.groupId, tokenId: item.tokenId, accountId },
						models: toProviderModels(item.models, legacy.models),
					};
				}
			}
			return {
				...config,
				providers: nextProviders,
				defaultModel: config.defaultModel || defaultModelKey,
			};
		},
		() => assertAccountRevision(revision),
	);
}

let modelRefreshPromise: Promise<void> | null = null;

/** Reconcile only already wired groups; preserve credentials, defaults and per-model tuning. */
async function syncCatalogProviders(catalog: FlowstokenCatalog): Promise<void> {
	const service = getDesktopModelSettingsService();
	const current = service.updateMetadataConfig((latest) => {
		const providers = { ...latest.providers };
		const now = Date.now();
		let changed = false;
		for (const group of catalog.groups) {
			const existing = providers[group.providerId];
			const models = catalogGroupModels(catalog, group.id);
			if (!existing?.apiKey || existing.managedGroupOverride) continue;
			const next = toProviderModels(models, existing.models);
			const syncedAt = Date.parse(existing.modelsSyncedAt ?? "");
			if (
				existing.catalogVersion === (catalog.revision ?? catalog.pricingVersion) &&
				JSON.stringify(existing.models) === JSON.stringify(next) &&
				Number.isFinite(syncedAt) &&
				now - syncedAt <= GROUP_MODELS_MAX_AGE_MS
			)
				continue;
			providers[group.providerId] = {
				...existing,
				models: next,
				modelsSyncedAt: new Date(now).toISOString(),
				catalogVersion: catalog.revision ?? catalog.pricingVersion,
			};
			changed = true;
		}
		return changed ? { ...latest, providers } : undefined;
	});
	modelRefreshPromise = current;
	try {
		await current;
	} finally {
		if (modelRefreshPromise === current) modelRefreshPromise = null;
	}
}

/** Opening a picker refreshes the runtime list before returning its display metadata. */
export async function getCatalogAndRefreshProviders(options: { force?: boolean } = {}): Promise<FlowstokenCatalog> {
	const catalog = await fetchCatalog(Date.now(), options);
	if (!catalog) return fallbackCatalog();
	await syncCatalogProviders(catalog);
	await provisionCatalogGroups(catalog, options);
	return catalog;
}

class CatalogSnapshotChangedError extends FlowstokenApiError {}

function catalogSnapshotIdentity(catalog: FlowstokenCatalog): string {
	const { source: _source, fetchedAt: _fetchedAt, ...content } = catalog;
	return JSON.stringify(content);
}

/** Return display metadata and its reconciled, masked config as one configuration-queue snapshot. */
export async function getCatalogSnapshot(options: { force?: boolean } = {}): Promise<{
	catalog: FlowstokenCatalog;
	config: ModelsConfig;
}> {
	const authRevision = getFlowstokenAuthRevision();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const catalog = await getCatalogAndRefreshProviders(attempt === 0 ? options : {});
		assertAccountRevision(authRevision);
		try {
			return await getDesktopModelSettingsService().readRendererSnapshot((config) => {
				assertAccountRevision(authRevision);
				const current = peekCachedCatalog();
				if (
					(current && catalogSnapshotIdentity(current) !== catalogSnapshotIdentity(catalog)) ||
					(!current && catalog.source !== "fallback")
				)
					throw new CatalogSnapshotChangedError(mainT("flowstoken.errors.catalogChanged"));
				return { catalog, config };
			});
		} catch (error) {
			if (!(error instanceof CatalogSnapshotChangedError) || attempt === 2) throw error;
		}
	}
	throw new CatalogSnapshotChangedError(mainT("flowstoken.errors.catalogChanged"));
}

let catalogProvision: { authRevision: number; catalogRevision: string | undefined; promise: Promise<void> } | null =
	null;
let checkedCatalogAccess: { authRevision: number; catalogRevision: string | undefined } | null = null;

/** Hot catalog additions use the same account queue as login, without changing saved defaults. */
async function provisionCatalogGroups(catalog: FlowstokenCatalog, options: { force?: boolean }): Promise<void> {
	if (catalog.schema !== 2 || getFlowstokenAccountId() === null || !automaticKeySyncAllowed()) return;
	const authRevision = getFlowstokenAuthRevision();
	if (catalogProvision?.authRevision === authRevision && catalogProvision.catalogRevision === catalog.revision)
		return catalogProvision.promise;
	if (catalogProvision) await catalogProvision.promise;
	const promise = (async () => {
		const force =
			options.force ||
			checkedCatalogAccess?.authRevision !== authRevision ||
			checkedCatalogAccess.catalogRevision !== catalog.revision;
		const access = await getAuthenticatedCatalogAccess({ force });
		assertAccountRevision(authRevision);
		checkedCatalogAccess = { authRevision, catalogRevision: catalog.revision };
		const config = await getDesktopModelSettingsService().getMetadataConfig();
		const pending = catalog.groups
			.filter((group) => {
				const provider = config.providers[group.providerId];
				return (
					!provider?.managedGroupOverride &&
					access.groups.has(group.id) &&
					(!provider?.apiKey ||
						provider.managedGroup?.accountId !== access.accountId ||
						provider.managedGroup.groupId !== group.id)
				);
			})
			.map((group) => group.id);
		if (pending.length === 0) return;
		const result = await queueGroupKeys(pending, { assignDefault: false }, true);
		if (result.snapshot) broadcastSnapshot(result.snapshot);
	})();
	catalogProvision = { authRevision, catalogRevision: catalog.revision, promise };
	try {
		await promise;
	} finally {
		if (catalogProvision?.promise === promise) catalogProvision = null;
	}
}

function triggerBackgroundModelRefreshIfStale(groups: FlowstokenGroupKeyState[]): void {
	if (modelRefreshPromise || !groups.some((group) => group.enabled && group.wired)) return;
	void (async () => {
		const config = await getDesktopModelSettingsService().getMetadataConfig();
		const stale = groups
			.filter((group) => group.enabled && group.wired)
			.some((group) => {
				const syncedAt = Date.parse(config.providers[group.providerId]?.modelsSyncedAt ?? "");
				return !Number.isFinite(syncedAt) || Date.now() - syncedAt > GROUP_MODELS_MAX_AGE_MS;
			});
		if (stale) await getCatalogAndRefreshProviders();
	})().catch((error) => console.warn("[FlowsToken] Background model list refresh failed:", error));
}

let keyEnsureQueue: Promise<void> = Promise.resolve();
const keyEnsureRequests = new Map<string, Promise<FlowstokenEnsureKeysResult>>();

function assertAccountRevision(revision: number): void {
	if (revision !== getFlowstokenAuthRevision())
		throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
}

export function ensureGroupKeysAndProviders(
	groupIds?: string[],
	options: { assignDefault?: boolean; allowManualOverride?: boolean } = {},
): Promise<FlowstokenEnsureKeysResult> {
	return queueGroupKeys(groupIds, options, false);
}

function queueGroupKeys(
	groupIds: string[] | undefined,
	options: { assignDefault?: boolean; allowManualOverride?: boolean },
	automatic: boolean,
): Promise<FlowstokenEnsureKeysResult> {
	const revision = getFlowstokenAuthRevision();
	const requestKey = JSON.stringify([
		revision,
		groupIds ? [...new Set(groupIds)].sort() : null,
		options.assignDefault !== false,
		options.allowManualOverride === true,
	]);
	const pending = keyEnsureRequests.get(requestKey);
	if (pending) return pending;
	const task = keyEnsureQueue
		.then(() => {
			// Account and catalog refreshes may race while an earlier attempt is still queued.
			// Recheck at execution time so one failed attempt establishes the next cooldown.
			if (automatic && (revision !== getFlowstokenAuthRevision() || !automaticKeySyncAllowed()))
				return { ok: false, created: [], reused: [], error: currentKeySyncError() };
			return ensureGroupKeys(groupIds, revision, options, automatic);
		})
		.finally(() => {
			if (keyEnsureRequests.get(requestKey) === task) keyEnsureRequests.delete(requestKey);
		});
	keyEnsureRequests.set(requestKey, task);
	keyEnsureQueue = task.then(
		() => {},
		() => {},
	);
	return task;
}

async function ensureGroupKeys(
	groupIds: string[] | undefined,
	revision: number,
	options: { assignDefault?: boolean; allowManualOverride?: boolean },
	automatic: boolean,
): Promise<FlowstokenEnsureKeysResult> {
	const created: string[] = [];
	const reused: string[] = [];
	let remoteFailureCanRetry = true;
	try {
		assertAccountRevision(revision);
		const user = await fetchSelf(getFlowstokenSession());
		assertAccountRevision(revision);
		const catalog = await getCatalog();
		const access = await getAuthenticatedCatalogAccess();
		assertAccountRevision(revision);
		if (access.accountId !== user.id) throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
		if (
			groupIds?.some(
				(id) =>
					!isValidBillingGroupId(id) || !catalog.groups.some((group) => group.id === id) || !access.groups.has(id),
			)
		)
			throw new FlowstokenApiError(mainT("flowstoken.errors.groupUnavailable"));
		remoteFailureCanRetry = false;
		const config = await getDesktopModelSettingsService().getMetadataConfig();
		remoteFailureCanRetry = true;
		const targets = catalog.groups.filter(
			(group) =>
				access.groups.has(group.id) &&
				(!groupIds || groupIds.includes(group.id)) &&
				(options.allowManualOverride || !config.providers[group.providerId]?.managedGroupOverride),
		);
		let tokens = await listTokens(getFlowstokenSession());
		assertAccountRevision(revision);
		const wireBatch: Array<{
			providerId: string;
			labelZh: string;
			apiKey: string;
			groupId: string;
			tokenId: number;
			models: readonly FlowstokenCatalogModel[];
		}> = [];

		for (const group of targets) {
			let managed = findManagedToken(tokens, group.id);
			if (!managed) {
				await createToken(getFlowstokenSession(), { name: managedTokenName(group.id), group: group.id });
				assertAccountRevision(revision);
				created.push(group.title);
				tokens = await listTokens(getFlowstokenSession());
				assertAccountRevision(revision);
				managed = findManagedToken(tokens, group.id);
			} else {
				reused.push(group.title);
			}
			if (!managed)
				throw new FlowstokenApiError(mainT("flowstoken.errors.tokenUnavailable", { group: group.title }));
			const key = await revealTokenKey(getFlowstokenSession(), managed.id);
			assertAccountRevision(revision);
			rememberVerifiedGroupKey(group.id, user.id, managed.id, key, revision);
			wireBatch.push({
				providerId: group.providerId,
				labelZh: group.title,
				apiKey: key,
				groupId: group.id,
				tokenId: managed.id,
				models: catalogGroupModels(catalog, group.id),
			});
		}

		if (wireBatch.length > 0) {
			const preferred = targets.find(
				(group) =>
					group.defaultModel &&
					catalogGroupModels(catalog, group.id).some(
						(model) => model.id === group.defaultModel && isChatModel(model),
					),
			);
			const first = targets.flatMap((group) =>
				catalogGroupModels(catalog, group.id)
					.filter(isChatModel)
					.map((model) => `${group.providerId}/${model.id}`),
			)[0];
			const defaultModelKey =
				options.assignDefault === false
					? undefined
					: preferred
						? `${preferred.providerId}/${preferred.defaultModel}`
						: first;
			remoteFailureCanRetry = false;
			await wireAllProviders(wireBatch, defaultModelKey, revision, user.id);
		}

		assertAccountRevision(revision);
		keySyncFailure = null;
		return { ok: true, created, reused, snapshot: await getAccountSnapshot() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (revision === getFlowstokenAuthRevision()) {
			const failures = automatic && keySyncFailure?.revision === revision ? keySyncFailure.failures + 1 : 1;
			const delay = remoteFailureCanRetry ? keyRetryDelay(error, failures) : null;
			keySyncFailure = { revision, message, failures, retryAt: delay === null ? null : Date.now() + delay };
		}
		return {
			ok: false,
			created,
			reused,
			error: message,
			snapshot: await getAccountSnapshot({ lastError: message }),
		};
	}
}

async function afterLogin(): Promise<FlowstokenAccountSnapshot> {
	// Authentication has succeeded. Later ordinary refreshes can retry transient provisioning failures.
	const ensured = await ensureGroupKeysAndProviders();
	return ensured.snapshot ?? (await getAccountSnapshot());
}

export async function loginWithBrowser(): Promise<FlowstokenLoginResult> {
	try {
		await loginViaSystemBrowser();
		return { ok: true, snapshot: await afterLogin() };
	} catch (error) {
		const message =
			error instanceof FlowstokenApiError ? error.message : mainT("flowstoken.errors.desktopAuthorizationFailed");
		return { ok: false, error: message };
	}
}

export async function loginWithCredentials(username: string, password: string): Promise<FlowstokenLoginResult> {
	try {
		await loginWithPasswordAndTurnstile(username.trim(), password);
		return { ok: true, snapshot: await afterLogin() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message, snapshot: await getAccountSnapshot({ lastError: message }) };
	}
}

export async function logoutAccount(): Promise<FlowstokenAccountSnapshot> {
	cancelSystemBrowserLogin();
	await clearFlowstokenSession();
	return signedOutSnapshot();
}

export async function refreshAccount(): Promise<FlowstokenAccountSnapshot> {
	return getAccountSnapshot({ includeUsage: true });
}
