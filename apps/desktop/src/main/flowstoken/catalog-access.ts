import { mainT } from "../i18n/index.js";
import type { ProviderConfig } from "../models/model-settings-service.js";
import { FLOWSTOKEN_GROUPS, FLOWSTOKEN_OPENAI_BASE_URL } from "./constants.js";
import {
	catalogGroupModels,
	getCatalog,
	isValidBillingGroupId,
	peekCachedCatalog,
	providerIdForGroup,
} from "./group-catalog.js";
import { getFlowstokenSession } from "./login-window.js";
import { rememberManagedCredential } from "./managed-credentials.js";
import {
	FlowstokenApiError,
	fetchUsableGroups,
	findManagedToken,
	getFlowstokenAccountId,
	getFlowstokenAuthRevision,
	listTokens,
	refreshAuth,
	revealTokenKey,
} from "./newapi-client.js";

const ACCESS_TTL_MS = 60_000;

export interface AuthenticatedCatalogAccess {
	readonly revision: number;
	readonly accountId: number;
	readonly groups: ReadonlySet<string>;
}

let accessCache: { at: number; access: AuthenticatedCatalogAccess } | null = null;
let accessRequest: { revision: number; promise: Promise<AuthenticatedCatalogAccess> } | null = null;

interface VerifiedGroupKey {
	revision: number;
	accountId: number;
	groupId: string;
	tokenId: number;
	key: string;
	at: number;
}
const verifiedKeys = new Map<string, VerifiedGroupKey>();
const keyRequests = new Map<string, { revision: number; promise: Promise<VerifiedGroupKey> }>();

/** Only the authenticated API preparation path can populate this session-private credential authority. */
export function rememberVerifiedGroupKey(
	groupId: string,
	accountId: number,
	tokenId: number,
	key: string,
	revision: number,
): void {
	if (revision !== getFlowstokenAuthRevision() || accountId !== getFlowstokenAccountId())
		throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
	verifiedKeys.set(groupId, { revision, accountId, groupId, tokenId, key, at: Date.now() });
	rememberManagedCredential({ revision, accountId, groupId, tokenId, key });
}

async function verifiedGroupKey(groupId: string, access: AuthenticatedCatalogAccess): Promise<VerifiedGroupKey> {
	const cached = verifiedKeys.get(groupId);
	if (
		cached?.revision === access.revision &&
		cached.accountId === access.accountId &&
		Date.now() - cached.at < ACCESS_TTL_MS
	)
		return cached;
	const pending = keyRequests.get(groupId);
	if (pending?.revision === access.revision) return pending.promise;
	const promise = (async () => {
		const session = getFlowstokenSession();
		const token = findManagedToken(await listTokens(session), groupId);
		if (!token) throw new FlowstokenApiError(mainT("flowstoken.errors.credentialStale"));
		const key = await revealTokenKey(session, token.id);
		rememberVerifiedGroupKey(groupId, access.accountId, token.id, key, access.revision);
		const verified = verifiedKeys.get(groupId);
		if (!verified) throw new FlowstokenApiError(mainT("flowstoken.errors.credentialStale"));
		return verified;
	})().finally(() => {
		if (keyRequests.get(groupId)?.promise === promise) keyRequests.delete(groupId);
	});
	keyRequests.set(groupId, { revision: access.revision, promise });
	return promise;
}

/** Metadata permissions are coalesced within an account generation; no balance/history endpoints are read. */
export function getAuthenticatedCatalogAccess(options: { force?: boolean } = {}): Promise<AuthenticatedCatalogAccess> {
	const revision = getFlowstokenAuthRevision();
	const accountId = getFlowstokenAccountId();
	if (accessRequest?.revision === revision) return accessRequest.promise;
	if (
		!options.force &&
		accessCache?.access.revision === revision &&
		accessCache.access.accountId === accountId &&
		Date.now() - accessCache.at < ACCESS_TTL_MS
	)
		return Promise.resolve(accessCache.access);
	const promise = (async () => {
		const session = getFlowstokenSession();
		if (getFlowstokenAccountId() === null) await refreshAuth(session);
		const currentAccountId = getFlowstokenAccountId();
		if (currentAccountId === null) throw new FlowstokenApiError(mainT("flowstoken.errors.authRequired"));
		const groups = await fetchUsableGroups(session);
		if (getFlowstokenAuthRevision() !== revision || getFlowstokenAccountId() !== currentAccountId)
			throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
		const access = { revision, accountId: currentAccountId, groups };
		accessCache = { at: Date.now(), access };
		return access;
	})().finally(() => {
		if (accessRequest?.promise === promise) accessRequest = null;
	});
	accessRequest = { revision, promise };
	return promise;
}

export function billingGroupForProvider(providerId: string): string | null {
	if (providerId === "flowstoken-normal") return "default";
	const legacy = FLOWSTOKEN_GROUPS.find((group) => group.providerId === providerId);
	if (legacy) return legacy.id;
	if (!providerId.startsWith("flowstoken-group-")) return null;
	const id = providerId.slice("flowstoken-group-".length);
	return isValidBillingGroupId(id) && providerIdForGroup(id) === providerId ? id : null;
}

export type FlowstokenAccessErrorCode =
	| "FLOWSTOKEN_AUTH_REQUIRED"
	| "FLOWSTOKEN_ENTITLEMENTS_UNAVAILABLE"
	| "FLOWSTOKEN_GROUP_UNAVAILABLE"
	| "FLOWSTOKEN_MODEL_UNAVAILABLE"
	| "FLOWSTOKEN_CREDENTIAL_STALE";

export class FlowstokenModelUnavailableError extends Error {
	constructor(
		readonly code: FlowstokenAccessErrorCode,
		readonly modelKey: string,
		message: string,
	) {
		super(message);
		this.name = "FlowstokenModelUnavailableError";
	}
}

/** Rechecks cached session model objects before credentials leave the shared runtime. */
export async function assertFlowstokenModelAccess(
	providerId: string,
	modelId: string | undefined,
	binding: ProviderConfig["managedGroup"],
	routedModelId?: string,
	transport?: { baseUrl?: string; headers?: Readonly<Record<string, string>> },
): Promise<{ assertCurrent(): void; assertCredential(credential: string | undefined): void } | undefined> {
	const groupId = billingGroupForProvider(providerId);
	if (!groupId) return;
	const modelKey = modelId === undefined ? providerId : `${providerId}/${modelId}`;
	if (transport) {
		let safe = false;
		try {
			const route = new URL(transport.baseUrl ?? "");
			safe = route.origin === new URL(FLOWSTOKEN_OPENAI_BASE_URL).origin && !route.username && !route.password;
		} catch {
			/* Invalid transport is unavailable. */
		}
		if (
			!safe ||
			Object.keys(transport.headers ?? {}).some((name) =>
				["authorization", "api-key", "apikey", "x-api-key", "cookie"].includes(name.toLowerCase()),
			)
		)
			throw new FlowstokenModelUnavailableError(
				"FLOWSTOKEN_CREDENTIAL_STALE",
				modelKey,
				mainT("flowstoken.errors.credentialStale"),
			);
	}
	const catalog = await getCatalog();
	const group = catalog.groups.find((entry) => entry.id === groupId);
	if (!group)
		throw new FlowstokenModelUnavailableError(
			"FLOWSTOKEN_GROUP_UNAVAILABLE",
			modelKey,
			mainT("flowstoken.errors.groupUnavailable"),
		);
	const chat = (model: ReturnType<typeof catalogGroupModels>[number]) =>
		model.kind ? model.kind === "chat" : !model.image;
	if (
		modelId !== undefined &&
		!catalogGroupModels(catalog, groupId).some((model) => model.id === modelId && chat(model))
	)
		throw new FlowstokenModelUnavailableError(
			"FLOWSTOKEN_MODEL_UNAVAILABLE",
			modelKey,
			mainT("flowstoken.errors.modelUnavailable"),
		);
	if (
		routedModelId !== undefined &&
		routedModelId !== modelId &&
		!catalogGroupModels(catalog, groupId).some((model) => model.id === routedModelId && chat(model))
	)
		throw new FlowstokenModelUnavailableError(
			"FLOWSTOKEN_MODEL_UNAVAILABLE",
			modelKey,
			mainT("flowstoken.errors.modelUnavailable"),
		);
	let access: AuthenticatedCatalogAccess;
	try {
		access = await getAuthenticatedCatalogAccess();
	} catch {
		throw new FlowstokenModelUnavailableError(
			getFlowstokenAccountId() === null ? "FLOWSTOKEN_AUTH_REQUIRED" : "FLOWSTOKEN_ENTITLEMENTS_UNAVAILABLE",
			modelKey,
			mainT(
				getFlowstokenAccountId() === null
					? "flowstoken.errors.authRequired"
					: "flowstoken.errors.entitlementsUnavailable",
			),
		);
	}
	if (!access.groups.has(groupId))
		throw new FlowstokenModelUnavailableError(
			"FLOWSTOKEN_GROUP_UNAVAILABLE",
			modelKey,
			mainT("flowstoken.errors.groupUnavailable"),
		);
	if (binding?.source !== "flowstoken" || binding.accountId !== access.accountId || binding.groupId !== groupId)
		throw new FlowstokenModelUnavailableError(
			"FLOWSTOKEN_CREDENTIAL_STALE",
			modelKey,
			mainT("flowstoken.errors.credentialStale"),
		);
	let expected: VerifiedGroupKey;
	try {
		expected = await verifiedGroupKey(groupId, access);
	} catch {
		throw new FlowstokenModelUnavailableError(
			"FLOWSTOKEN_CREDENTIAL_STALE",
			modelKey,
			mainT("flowstoken.errors.credentialStale"),
		);
	}
	const assertCurrent = () => {
		const latest = peekCachedCatalog();
		if (latest && !latest.groups.some((entry) => entry.id === groupId))
			throw new FlowstokenModelUnavailableError(
				"FLOWSTOKEN_GROUP_UNAVAILABLE",
				modelKey,
				mainT("flowstoken.errors.groupUnavailable"),
			);
		if (
			latest &&
			modelId !== undefined &&
			!catalogGroupModels(latest, groupId).some((model) => model.id === modelId && chat(model))
		)
			throw new FlowstokenModelUnavailableError(
				"FLOWSTOKEN_MODEL_UNAVAILABLE",
				modelKey,
				mainT("flowstoken.errors.modelUnavailable"),
			);
		if (
			latest &&
			routedModelId !== undefined &&
			!catalogGroupModels(latest, groupId).some((model) => model.id === routedModelId && chat(model))
		)
			throw new FlowstokenModelUnavailableError(
				"FLOWSTOKEN_MODEL_UNAVAILABLE",
				modelKey,
				mainT("flowstoken.errors.modelUnavailable"),
			);
		const observed = accessCache?.access;
		if (
			observed?.revision === access.revision &&
			observed.accountId === access.accountId &&
			!observed.groups.has(groupId)
		)
			throw new FlowstokenModelUnavailableError(
				"FLOWSTOKEN_GROUP_UNAVAILABLE",
				modelKey,
				mainT("flowstoken.errors.groupUnavailable"),
			);
		const current = verifiedKeys.get(groupId);
		if (
			access.revision !== getFlowstokenAuthRevision() ||
			access.accountId !== getFlowstokenAccountId() ||
			current?.key !== expected.key ||
			current.tokenId !== expected.tokenId
		)
			throw new FlowstokenModelUnavailableError(
				"FLOWSTOKEN_CREDENTIAL_STALE",
				modelKey,
				mainT("flowstoken.errors.accountChanged"),
			);
	};
	assertCurrent();
	return {
		assertCurrent,
		assertCredential: (credential) => {
			assertCurrent();
			if (credential !== expected.key)
				throw new FlowstokenModelUnavailableError(
					"FLOWSTOKEN_CREDENTIAL_STALE",
					modelKey,
					mainT("flowstoken.errors.credentialStale"),
				);
		},
	};
}

export function resetCatalogAccessForTests(): void {
	accessCache = null;
	verifiedKeys.clear();
}
