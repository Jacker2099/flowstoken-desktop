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
	FlowstokenEnsureKeysResult,
	FlowstokenGroupKeyState,
	FlowstokenLoginResult,
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

	return {
		loggedIn: true,
		user,
		balanceUsd: usd(user.quota),
		usedUsd: usd(user.usedQuota),
		groups: await groupStates(),
		usage,
		siteUrl: FLOWSTOKEN_SITE_URL,
		topupUrl: FLOWSTOKEN_TOPUP_URL,
		consoleUrl: FLOWSTOKEN_CONSOLE_URL,
		lastError: options?.lastError,
		updatedAt: Date.now(),
	};
}

async function wireProvider(
	providerId: string,
	labelZh: string,
	apiKey: string,
	modelIds: readonly string[],
): Promise<void> {
	const service = getDesktopModelSettingsService();
	const config = await service.getConfig();
	const existing = config.providers[providerId];
	await service.replaceConfig({
		...config,
		providers: {
			...config.providers,
			[providerId]: {
				...existing,
				source: "template",
				templateId: providerId,
				displayName: `FlowsToken ${labelZh}`,
				icon: "openai",
				api: "openai-completions",
				baseUrl: FLOWSTOKEN_OPENAI_BASE_URL,
				apiKey,
				models:
					modelIds.length > 0
						? modelIds.map((id) => ({ id, name: id, api: "openai-completions" }))
						: (existing?.models ?? []),
				modelsSyncedAt: new Date().toISOString(),
			},
		},
	});
}

export async function ensureGroupKeysAndProviders(groupIds?: FlowstokenGroupId[]): Promise<FlowstokenEnsureKeysResult> {
	const created: string[] = [];
	const reused: string[] = [];
	try {
		await fetchSelf(getFlowstokenSession());
		const targets = FLOWSTOKEN_GROUPS.filter((g) => !groupIds || groupIds.includes(g.id));
		let tokens = await listTokens(getFlowstokenSession());
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
			await wireProvider(group.providerId, group.labelZh, key, group.defaultModels);
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
	const ensured = await ensureGroupKeysAndProviders();
	return ensured.snapshot ?? (await getAccountSnapshot());
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
