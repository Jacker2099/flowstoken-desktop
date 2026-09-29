import { getDesktopModelSettingsService } from "../models/model-settings-host.js";
import {
	FLOWSTOKEN_CONSOLE_URL,
	FLOWSTOKEN_GROUPS,
	FLOWSTOKEN_OPENAI_BASE_URL,
	FLOWSTOKEN_QUOTA_PER_USD,
	FLOWSTOKEN_SITE_URL,
	FLOWSTOKEN_TOPUP_URL,
	type FlowstokenGroupId,
} from "./constants.js";
import {
	catalogGroupModels,
	fallbackGroupModels,
	fetchCatalog,
	GROUP_MODELS_MAX_AGE_MS,
	getCatalog,
} from "./group-catalog.js";
import {
	clearFlowstokenSession,
	getFlowstokenSession,
	loginViaBrowserWindow,
	loginWithPasswordAndTurnstile,
	probeExistingSession,
} from "./login-window.js";
import {
	createToken,
	FlowstokenApiError,
	fetchSelf,
	fetchSelfLogs,
	findManagedToken,
	listTokens,
	revealTokenKey,
} from "./newapi-client.js";
import type {
	FlowstokenAccountSnapshot,
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

async function groupStates(): Promise<FlowstokenGroupKeyState[]> {
	const config = await getDesktopModelSettingsService().getConfig();
	let tokens: Awaited<ReturnType<typeof listTokens>> = [];
	try {
		tokens = await listTokens(getFlowstokenSession());
	} catch {
		tokens = [];
	}
	return FLOWSTOKEN_GROUPS.map((group) => {
		const managed = findManagedToken(tokens, group.id);
		const provider = config.providers[group.providerId];
		const wired = Boolean(provider?.apiKey);
		return {
			groupId: group.id,
			providerId: group.providerId,
			labelZh: group.labelZh,
			tokenName: group.tokenName,
			tokenId: managed?.id,
			wired,
			enabled: wired,
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

function triggerBackgroundSyncIfUnwired(user: FlowstokenUserSnapshot | null, groups: FlowstokenGroupKeyState[]): void {
	if (!user) return;
	if (groups.length > 0 && groups.every((g) => g.wired)) return;
	if (autoSyncPromise) return;

	autoSyncPromise = (async () => {
		try {
			const res = await ensureGroupKeysAndProviders();
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
	const includeUsage = options?.includeUsage ?? true;
	const user = await probeExistingSession();
	if (!user) {
		return {
			loggedIn: false,
			user: null,
			balanceUsd: "$0.0000",
			usedUsd: "$0.0000",
			groups: FLOWSTOKEN_GROUPS.map((g) => ({
				groupId: g.id,
				providerId: g.providerId,
				labelZh: g.labelZh,
				tokenName: g.tokenName,
				wired: false,
				enabled: false,
			})),
			usage: [],
			siteUrl: FLOWSTOKEN_SITE_URL,
			topupUrl: FLOWSTOKEN_TOPUP_URL,
			consoleUrl: FLOWSTOKEN_CONSOLE_URL,
			lastError: options?.lastError,
			updatedAt: Date.now(),
		};
	}

	let usage: FlowstokenAccountSnapshot["usage"] = [];
	if (includeUsage) {
		try {
			usage = await fetchSelfLogs(getFlowstokenSession(), 25);
		} catch {
			usage = [];
		}
	}

	const groups = await groupStates();
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
		lastError: options?.lastError,
		updatedAt: Date.now(),
	};
}

function toProviderModels(models: readonly FlowstokenCatalogModel[]) {
	return models.map((model) => ({ id: model.id, name: model.name, api: "openai-completions" as const }));
}

async function wireAllProviders(
	items: Array<{
		providerId: string;
		labelZh: string;
		apiKey: string;
		models: readonly FlowstokenCatalogModel[];
	}>,
	smartDefaultModel: string,
): Promise<void> {
	const service = getDesktopModelSettingsService();
	const config = await service.getConfig();
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
			models: item.models.length > 0 ? toProviderModels(item.models) : (existing?.models ?? []),
			modelsSyncedAt: new Date().toISOString(),
		};
	}
	await service.replaceConfig({
		...config,
		providers: nextProviders,
		defaultModel:
			!config.defaultModel || !config.defaultModel.startsWith("flowstoken-")
				? `flowstoken-smart/${smartDefaultModel}`
				: config.defaultModel,
	});
}

let modelRefreshPromise: Promise<void> | null = null;

/**
 * Keys are wired once, but the site adds and retires models: refresh the model lists of already wired groups when
 * they are older than GROUP_MODELS_MAX_AGE_MS. Keys, provider settings and the default model stay untouched.
 */
function triggerBackgroundModelRefreshIfStale(groups: FlowstokenGroupKeyState[]): void {
	if (modelRefreshPromise || groups.length === 0 || !groups.every((g) => g.wired)) return;
	modelRefreshPromise = (async () => {
		try {
			const service = getDesktopModelSettingsService();
			const config = await service.getConfig();
			const now = Date.now();
			const stale = FLOWSTOKEN_GROUPS.some((group) => {
				const syncedAt = Date.parse(config.providers[group.providerId]?.modelsSyncedAt ?? "");
				return !Number.isFinite(syncedAt) || now - syncedAt > GROUP_MODELS_MAX_AGE_MS;
			});
			if (!stale) return;
			const catalog = await fetchCatalog(now);
			if (!catalog) return;
			const latest = await service.getConfig();
			const providers = { ...latest.providers };
			for (const group of FLOWSTOKEN_GROUPS) {
				const existing = providers[group.providerId];
				const models = catalogGroupModels(catalog, group.id);
				if (!existing?.apiKey || models.length === 0) continue;
				const next = toProviderModels(models);
				// Rewrite when the pricing version moved or the model list itself changed.
				// `catalogVersion` rides the provider row as an untyped overlay field.
				const unchanged =
					(existing as { catalogVersion?: string }).catalogVersion === catalog.pricingVersion &&
					JSON.stringify(existing.models) === JSON.stringify(next);
				if (unchanged) {
					providers[group.providerId] = { ...existing, modelsSyncedAt: new Date(now).toISOString() };
					continue;
				}
				providers[group.providerId] = {
					...existing,
					models: next,
					modelsSyncedAt: new Date(now).toISOString(),
					catalogVersion: catalog.pricingVersion,
				} as typeof existing;
			}
			await service.replaceConfig({ ...latest, providers });
		} catch (e) {
			console.warn("[FlowsToken] Background model list refresh failed:", e);
		} finally {
			modelRefreshPromise = null;
		}
	})();
}

export async function ensureGroupKeysAndProviders(groupIds?: FlowstokenGroupId[]): Promise<FlowstokenEnsureKeysResult> {
	const created: string[] = [];
	const reused: string[] = [];
	try {
		await fetchSelf(getFlowstokenSession());
		const targets = FLOWSTOKEN_GROUPS.filter((g) => !groupIds || groupIds.includes(g.id));
		let tokens = await listTokens(getFlowstokenSession());
		const catalog = await getCatalog();
		const smartDefault = catalog.groups.find((g) => g.id === "smart")?.defaultModel ?? "Bestoo-Auto";
		const wireBatch: Array<{
			providerId: string;
			labelZh: string;
			apiKey: string;
			models: readonly FlowstokenCatalogModel[];
		}> = [];

		for (const group of targets) {
			let managed = findManagedToken(tokens, group.id);
			if (!managed) {
				await createToken(getFlowstokenSession(), { name: group.tokenName, group: group.id });
				created.push(group.labelZh);
				tokens = await listTokens(getFlowstokenSession());
				managed = findManagedToken(tokens, group.id);
			} else {
				reused.push(group.labelZh);
			}
			if (!managed) throw new FlowstokenApiError(`无法准备「${group.labelZh}」令牌`);
			const key = await revealTokenKey(getFlowstokenSession(), managed.id);
			wireBatch.push({
				providerId: group.providerId,
				labelZh: group.labelZh,
				apiKey: key,
				models: catalogGroupModels(catalog, group.id).length
					? catalogGroupModels(catalog, group.id)
					: fallbackGroupModels(group.id),
			});
		}

		if (wireBatch.length > 0) {
			await wireAllProviders(wireBatch, smartDefault);
		}

		return { ok: true, created, reused, snapshot: await getAccountSnapshot() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
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
	let lastSnapshot: FlowstokenAccountSnapshot | null = null;
	// Retry up to 3 times with exponential backoff to ensure keys and providers are completely wired
	for (let attempt = 1; attempt <= 3; attempt++) {
		const ensured = await ensureGroupKeysAndProviders();
		lastSnapshot = ensured.snapshot ?? null;
		if (ensured.ok && lastSnapshot?.groups.every((g) => g.wired)) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
	}
	return lastSnapshot ?? (await getAccountSnapshot());
}

export async function loginWithBrowser(): Promise<FlowstokenLoginResult> {
	try {
		await loginViaBrowserWindow();
		return { ok: true, snapshot: await afterLogin() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message, snapshot: await getAccountSnapshot({ lastError: message }) };
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
	await clearFlowstokenSession();
	return getAccountSnapshot({ includeUsage: false });
}

export async function refreshAccount(): Promise<FlowstokenAccountSnapshot> {
	return getAccountSnapshot({ includeUsage: true });
}
