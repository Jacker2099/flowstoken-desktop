import { net, type Session } from "electron";
import { FLOWSTOKEN_API_ORIGIN, FLOWSTOKEN_GROUPS, type FlowstokenGroupId } from "./constants.js";
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

export function clearCachedAccessToken(): void {
	cachedAccessToken = null;
}

export function getCachedAccessToken(): string | null {
	return cachedAccessToken;
}

export function setCachedAccessToken(token: string | null | undefined): void {
	const trimmed = typeof token === "string" ? token.trim() : "";
	cachedAccessToken = trimmed || null;
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
	return {
		id: Number(data.id),
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
	if (typeof session.fetch === "function") {
		return session.fetch(url, {
			...init,
			credentials: init.credentials ?? "include",
		});
	}
	return net.fetch(url, {
		...init,
		credentials: init.credentials ?? "include",
		...({ session } as object),
	} as RequestInit);
}

export async function refreshAuth(session: Session): Promise<{
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
	let json: ApiEnvelope<RefreshPayload> | null = null;
	try {
		json = text ? (JSON.parse(text) as ApiEnvelope<RefreshPayload>) : null;
	} catch {
		throw new FlowstokenApiError(`刷新会话响应不是 JSON（HTTP ${response.status}）`, response.status);
	}

	if (!response.ok || json?.success === false) {
		clearCachedAccessToken();
		throw new FlowstokenApiError(json?.message || `刷新会话失败（HTTP ${response.status}）`, response.status);
	}

	const data = (json?.data ?? null) as RefreshPayload | null;
	const accessToken = pickAccessToken(data);
	if (!accessToken) {
		clearCachedAccessToken();
		throw new FlowstokenApiError("刷新会话未返回 access_token", response.status);
	}
	setCachedAccessToken(accessToken);

	if (data?.user && typeof data.user === "object") {
		return { accessToken, user: mapUser(data.user) };
	}
	if (data && data.id !== undefined) {
		return { accessToken, user: mapUser(data) };
	}
	return { accessToken, user: await fetchSelfWithBearer(session, accessToken) };
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
	const url = new URL(path, FLOWSTOKEN_API_ORIGIN);
	if (init.query) {
		for (const [key, value] of Object.entries(init.query)) {
			if (value === undefined || value === "") continue;
			url.searchParams.set(key, String(value));
		}
	}

	const send = async (accessToken: string): Promise<Response> => {
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
	if (response.status === 401) {
		clearCachedAccessToken();
		accessToken = (await refreshAuth(session)).accessToken;
		response = await send(accessToken);
	}

	const text = await response.text();
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

async function fetchSelfWithBearer(session: Session, accessToken: string): Promise<FlowstokenUserSnapshot> {
	const url = new URL("/api/user/self", FLOWSTOKEN_API_ORIGIN).toString();
	const response = await sessionFetch(session, url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
	});
	const text = await response.text();
	let json: ApiEnvelope<Record<string, unknown>> | null = null;
	try {
		json = text ? (JSON.parse(text) as ApiEnvelope<Record<string, unknown>>) : null;
	} catch {
		throw new FlowstokenApiError(`响应不是 JSON（HTTP ${response.status}）`, response.status);
	}
	if (!response.ok || json?.success === false) {
		throw new FlowstokenApiError(json?.message || `HTTP ${response.status}`, response.status);
	}
	return mapUser((json?.data ?? json) as Record<string, unknown>);
}

export async function fetchSelf(session: Session): Promise<FlowstokenUserSnapshot> {
	try {
		return (await refreshAuth(session)).user;
	} catch (refreshError) {
		if (cachedAccessToken) {
			try {
				return await fetchSelfWithBearer(session, cachedAccessToken);
			} catch {
				clearCachedAccessToken();
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

	if (userRaw) return mapUser(userRaw);
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

export async function listTokens(session: Session, page = 0, pageSize = 100): Promise<NewApiTokenRow[]> {
	const data = await apiFetch<PageInfo<NewApiTokenRow> | NewApiTokenRow[]>(session, "/api/token/", {
		query: { p: page, page_size: pageSize },
	});
	if (Array.isArray(data)) return data;
	if (Array.isArray(data.items)) return data.items;
	if (Array.isArray(data.data)) return data.data;
	return [];
}

export async function createToken(session: Session, input: { name: string; group: FlowstokenGroupId }): Promise<void> {
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

export function findManagedToken(tokens: NewApiTokenRow[], groupId: FlowstokenGroupId): NewApiTokenRow | undefined {
	const meta = FLOWSTOKEN_GROUPS.find((g) => g.id === groupId);
	if (!meta) return undefined;
	return (
		tokens.find((t) => t.name === meta.tokenName) ??
		tokens.find((t) => t.group === groupId && String(t.name).includes("FlowsToken-Desktop"))
	);
}
