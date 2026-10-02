import { createHash } from "node:crypto";
import { net, type Session } from "electron";
import { mainT } from "../i18n/index.js";
import { FLOWSTOKEN_API_ORIGIN, FLOWSTOKEN_GROUPS } from "./constants.js";
import { isValidBillingGroupId } from "./group-catalog.js";
import type { FlowstokenUsageRow, FlowstokenUserSnapshot } from "./types.js";

interface ApiEnvelope<T> {
	success?: boolean;
	message?: string;
	data?: T;
}

export class FlowstokenApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "FlowstokenApiError";
	}
}

/**
 * Production NewAPI auth on www.flowstoken.com:
 * - HttpOnly cookie `new_api_refresh` (Path=/api/user/auth, SameSite=Strict)
 * - SPA calls POST /api/user/auth/refresh then uses Bearer access_token
 * - GET /api/user/self requires Authorization: Bearer (refresh cookie is NOT sent there)
 *
 * Desktop used to poll /api/user/self with partition cookies only, so one-click login
 * never resolved after the popup reached the console.
 */
let cachedAccessToken: string | null = null;
let cachedAccountId: number | null = null;
let authRevision = 0;
let refreshRequest: {
	session: Session;
	revision: number;
	promise: Promise<{ accessToken: string; user: FlowstokenUserSnapshot }>;
} | null = null;

export function clearCachedAccessToken(): void {
	cachedAccessToken = null;
	cachedAccountId = null;
	authRevision++;
}

export function getCachedAccessToken(): string | null {
	return cachedAccessToken;
}

export function getFlowstokenAuthRevision(): number {
	return authRevision;
}

export function getFlowstokenAccountId(): number | null {
	return cachedAccountId;
}

export function setCachedAccessToken(token: string | null | undefined): void {
	const trimmed = typeof token === "string" ? token.trim() : "";
	cachedAccessToken = trimmed || null;
	cachedAccountId = null;
	authRevision++;
}

function assertCurrentAuth(revision: number): void {
	if (revision !== authRevision) throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
}

type RefreshPayload = {
	access_token?: string;
	accessToken?: string;
	token?: string;
	user?: Record<string, unknown>;
} & Record<string, unknown>;

function pickAccessToken(data: RefreshPayload | null | undefined): string | null {
	if (!data) return null;
	const raw = data.access_token ?? data.accessToken ?? data.token;
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function mapUser(data: Record<string, unknown>): FlowstokenUserSnapshot {
	const id = Number(data.id);
	if (!Number.isSafeInteger(id) || id <= 0) throw new FlowstokenApiError(mainT("flowstoken.errors.invalidAccount"));
	return {
		id,
		username: String(data.username ?? ""),
		displayName: String(data.display_name || data.username || ""),
		email: data.email ? String(data.email) : undefined,
		group: data.group ? String(data.group) : undefined,
		quota: Number(data.quota ?? 0),
		usedQuota: Number(data.used_quota ?? 0),
		requestCount: Number(data.request_count ?? 0),
	};
}

async function sessionFetch(session: Session, url: string, init: RequestInit): Promise<Response> {
	const revision = authRevision;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new FlowstokenApiError(mainT("flowstoken.errors.requestTimeout"));
			controller.abort(error);
			reject(error);
		}, 15_000);
	});
	const request = (async () => {
		const headers = new Headers(init.headers);
		try {
			const cookies = await session.cookies.get({ url });
			const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
			if (cookieStr && !headers.has("Cookie")) {
				headers.set("Cookie", cookieStr);
			}
		} catch {
			// Non-blocking
		}
		assertCurrentAuth(revision);
		controller.signal.throwIfAborted();

		if (!headers.has("Origin")) {
			headers.set("Origin", FLOWSTOKEN_API_ORIGIN);
		}
		if (!headers.has("Referer")) {
			headers.set("Referer", `${FLOWSTOKEN_API_ORIGIN}/`);
		}

		const options = {
			...init,
			headers,
			signal: controller.signal,
			credentials: init.credentials ?? "include",
		};
		const response =
			typeof session.fetch === "function"
				? await session.fetch(url, options)
				: await net.fetch(url, { ...options, ...({ session } as object) } as RequestInit);
		const body = await response.arrayBuffer();
		controller.signal.throwIfAborted();
		assertCurrentAuth(revision);
		return new Response([204, 205, 304].includes(response.status) ? null : body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	})();
	try {
		return await Promise.race([request, expired]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function performRefresh(
	session: Session,
	revision: number,
): Promise<{
	accessToken: string;
	user: FlowstokenUserSnapshot;
}> {
	const url = new URL("/api/user/auth/refresh", FLOWSTOKEN_API_ORIGIN).toString();
	const response = await sessionFetch(session, url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Cache-Control": "no-store",
		},
	});

	const text = await response.text();
	assertCurrentAuth(revision);
	let json: ApiEnvelope<RefreshPayload> | null = null;
	try {
		json = text ? (JSON.parse(text) as ApiEnvelope<RefreshPayload>) : null;
	} catch {
		throw new FlowstokenApiError(`刷新会话响应不是 JSON（HTTP ${response.status}）`, response.status);
	}

	if (!response.ok || json?.success === false) {
		cachedAccessToken = null;
		cachedAccountId = null;
		throw new FlowstokenApiError(json?.message || `刷新会话失败（HTTP ${response.status}）`, response.status);
	}

	const data = (json?.data ?? null) as RefreshPayload | null;
	const accessToken = pickAccessToken(data);
	if (!accessToken) {
		cachedAccessToken = null;
		cachedAccountId = null;
		throw new FlowstokenApiError("刷新会话未返回 access_token", response.status);
	}
	let user: FlowstokenUserSnapshot;
	if (data?.user && typeof data.user === "object") {
		user = mapUser(data.user);
	} else if (data && data.id !== undefined) {
		user = mapUser(data);
	} else {
		user = await fetchSelfWithBearer(session, accessToken, revision, false);
	}
	assertCurrentAuth(revision);
	if (cachedAccountId !== null && cachedAccountId !== user.id) authRevision++;
	cachedAccessToken = accessToken;
	cachedAccountId = user.id;
	return { accessToken, user };
}

export function refreshAuth(session: Session): Promise<{ accessToken: string; user: FlowstokenUserSnapshot }> {
	if (refreshRequest?.session === session && refreshRequest.revision === authRevision) return refreshRequest.promise;
	const revision = authRevision;
	const promise = performRefresh(session, revision).finally(() => {
		if (refreshRequest?.promise === promise) refreshRequest = null;
	});
	refreshRequest = { session, revision, promise };
	return promise;
}

async function ensureAccessToken(session: Session): Promise<string> {
	if (cachedAccessToken) return cachedAccessToken;
	return (await refreshAuth(session)).accessToken;
}

async function apiFetch<T>(
	session: Session,
	path: string,
	init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
	const revision = authRevision;
	const url = new URL(path, FLOWSTOKEN_API_ORIGIN);
	if (init.query) {
		for (const [key, value] of Object.entries(init.query)) {
			if (value === undefined || value === "") continue;
			url.searchParams.set(key, String(value));
		}
	}

	const send = async (accessToken: string): Promise<Response> => {
		assertCurrentAuth(revision);
		const headers = new Headers(init.headers);
		if (init.body && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/json");
		}
		headers.set("Accept", "application/json");
		headers.set("Authorization", `Bearer ${accessToken}`);
		return sessionFetch(session, url.toString(), {
			method: init.method ?? "GET",
			headers,
			body: init.body,
		});
	};

	let accessToken = await ensureAccessToken(session);
	let response = await send(accessToken);
	assertCurrentAuth(revision);
	if (response.status === 401) {
		cachedAccessToken = null;
		accessToken = (await refreshAuth(session)).accessToken;
		response = await send(accessToken);
	}

	const text = await response.text();
	assertCurrentAuth(revision);
	let json: ApiEnvelope<T> | null = null;
	try {
		json = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;
	} catch {
		throw new FlowstokenApiError(`响应不是 JSON（HTTP ${response.status}）`, response.status);
	}
	if (!response.ok) {
		throw new FlowstokenApiError(json?.message || `HTTP ${response.status}`, response.status);
	}
	if (json && json.success === false) {
		throw new FlowstokenApiError(json.message || "请求失败", response.status);
	}
	return (json?.data ?? (json as unknown as T)) as T;
}

async function fetchSelfWithBearer(
	session: Session,
	accessToken: string,
	revision = authRevision,
	commitIdentity = true,
): Promise<FlowstokenUserSnapshot> {
	assertCurrentAuth(revision);
	const url = new URL("/api/user/self", FLOWSTOKEN_API_ORIGIN).toString();
	const response = await sessionFetch(session, url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
	});
	const text = await response.text();
	assertCurrentAuth(revision);
	let json: ApiEnvelope<Record<string, unknown>> | null = null;
	try {
		json = text ? (JSON.parse(text) as ApiEnvelope<Record<string, unknown>>) : null;
	} catch {
		throw new FlowstokenApiError(`响应不是 JSON（HTTP ${response.status}）`, response.status);
	}
	if (!response.ok || json?.success === false) {
		throw new FlowstokenApiError(json?.message || `HTTP ${response.status}`, response.status);
	}
	const user = mapUser((json?.data ?? json) as Record<string, unknown>);
	if (commitIdentity) {
		if (cachedAccountId !== null && cachedAccountId !== user.id) authRevision++;
		cachedAccountId = user.id;
	}
	return user;
}

export async function fetchSelf(session: Session): Promise<FlowstokenUserSnapshot> {
	const revision = authRevision;
	try {
		return (await refreshAuth(session)).user;
	} catch (refreshError) {
		assertCurrentAuth(revision);
		if (cachedAccessToken) {
			try {
				return await fetchSelfWithBearer(session, cachedAccessToken, revision);
			} catch {
				assertCurrentAuth(revision);
				cachedAccessToken = null;
				cachedAccountId = null;
			}
		}
		throw refreshError;
	}
}

export async function loginWithPassword(
	session: Session,
	username: string,
	password: string,
	turnstileToken: string,
): Promise<FlowstokenUserSnapshot> {
	const revision = authRevision;
	const url = new URL("/api/user/login", FLOWSTOKEN_API_ORIGIN);
	url.searchParams.set("turnstile", turnstileToken);
	const response = await sessionFetch(session, url.toString(), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ username, password }),
	});
	const json = (await response.json()) as ApiEnvelope<RefreshPayload>;
	assertCurrentAuth(revision);
	if (!response.ok || json.success === false) {
		throw new FlowstokenApiError(json.message || "登录失败", response.status);
	}

	const token = pickAccessToken(json.data ?? undefined);
	if (token) setCachedAccessToken(token);

	const userRaw =
		json.data?.user && typeof json.data.user === "object"
			? json.data.user
			: json.data && json.data.id !== undefined
				? json.data
				: null;

	if (!cachedAccessToken) {
		try {
			return (await refreshAuth(session)).user;
		} catch {
			if (userRaw) return mapUser(userRaw);
			throw new FlowstokenApiError("登录成功但无法刷新访问令牌");
		}
	}

	if (userRaw) {
		const user = mapUser(userRaw);
		cachedAccountId = user.id;
		return user;
	}
	return fetchSelf(session);
}

export interface NewApiTokenRow {
	id: number;
	name: string;
	group?: string;
	status?: number;
}

interface PageInfo<T> {
	items?: T[];
	data?: T[];
}

export async function listTokens(session: Session, page?: number, pageSize = 100): Promise<NewApiTokenRow[]> {
	const size = Math.min(100, Math.max(1, pageSize));
	const result: NewApiTokenRow[] = [];
	const seen = new Set<number>();
	for (let currentPage = page ?? 1; ; currentPage++) {
		const data = await apiFetch<(PageInfo<NewApiTokenRow> & { total?: number }) | NewApiTokenRow[]>(
			session,
			"/api/token/",
			{
				query: { p: currentPage, page_size: size },
			},
		);
		const rows = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : data.data;
		if (!Array.isArray(rows)) throw new FlowstokenApiError(mainT("flowstoken.errors.tokenInventoryUnavailable"));
		const before = result.length;
		for (const row of rows)
			if (!seen.has(row.id)) {
				seen.add(row.id);
				result.push(row);
			}
		const total = Array.isArray(data) ? undefined : data.total;
		if (page !== undefined || rows.length < size || (typeof total === "number" && result.length >= total))
			return result;
		if (result.length === before) throw new FlowstokenApiError(mainT("flowstoken.errors.tokenInventoryUnavailable"));
	}
}

/** Entitlements come from the authenticated account API, never from the public model catalog. */
export async function fetchUsableGroups(session: Session): Promise<ReadonlySet<string>> {
	const data = await apiFetch<unknown>(session, "/api/user/self/groups");
	if (typeof data !== "object" || data === null || Array.isArray(data))
		throw new FlowstokenApiError(mainT("flowstoken.errors.entitlementsUnavailable"));
	const groups = new Set<string>();
	for (const [id, value] of Object.entries(data)) {
		if (!isValidBillingGroupId(id) || typeof value !== "object" || value === null || Array.isArray(value))
			throw new FlowstokenApiError(mainT("flowstoken.errors.invalidEntitlements"));
		groups.add(id);
	}
	return groups;
}

/** Legacy names stay intact; new names remain stable and below NewAPI's 50-byte limit. */
export function managedTokenName(groupId: string): string {
	const legacy = FLOWSTOKEN_GROUPS.find((group) => group.id === groupId);
	return legacy?.tokenName ?? `FlowsToken-Desktop-${createHash("sha256").update(groupId).digest("hex").slice(0, 30)}`;
}

export async function createToken(session: Session, input: { name: string; group: string }): Promise<void> {
	await apiFetch(session, "/api/token/", {
		method: "POST",
		body: JSON.stringify({
			name: input.name,
			remain_quota: 0,
			expired_time: -1,
			unlimited_quota: true,
			model_limits_enabled: false,
			model_limits: "",
			allow_ips: "",
			group: input.group,
		}),
	});
}

export async function revealTokenKey(session: Session, tokenId: number): Promise<string> {
	const data = await apiFetch<{ key?: string }>(session, `/api/token/${tokenId}/key`, {
		method: "POST",
		body: "{}",
	});
	const key = data?.key?.trim();
	if (!key) throw new FlowstokenApiError("令牌密钥为空");
	return key.startsWith("sk-") ? key : `sk-${key}`;
}

export async function fetchSelfLogs(session: Session, pageSize = 30): Promise<FlowstokenUsageRow[]> {
	const data = await apiFetch<PageInfo<Record<string, unknown>> | Record<string, unknown>[]>(
		session,
		"/api/log/self",
		{ query: { p: 0, page_size: pageSize, type: 2 } },
	);
	const rows = Array.isArray(data) ? data : (data.items ?? data.data ?? []);
	return rows.map((row) => ({
		id: Number(row.id ?? 0),
		createdAt: Number(row.created_at ?? 0),
		modelName: String(row.model_name ?? ""),
		quota: Number(row.quota ?? 0),
		promptTokens: Number(row.prompt_tokens ?? 0),
		completionTokens: Number(row.completion_tokens ?? 0),
		tokenName: row.token_name ? String(row.token_name) : undefined,
		group: row.group ? String(row.group) : undefined,
		content: row.content ? String(row.content) : undefined,
	}));
}

export function findManagedToken(tokens: NewApiTokenRow[], groupId: string): NewApiTokenRow | undefined {
	const meta = FLOWSTOKEN_GROUPS.find((g) => g.id === groupId);
	const usable = tokens.filter(
		(token) => token.group === groupId && token.status === 1 && Number.isSafeInteger(token.id) && token.id > 0,
	);
	return (
		usable.find((token) => token.name === managedTokenName(groupId)) ??
		(meta ? usable.find((token) => String(token.name).includes("FlowsToken-Desktop")) : undefined)
	);
}
