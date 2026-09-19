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
	const headers = new Headers(init.headers);
	if (init.body && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	headers.set("Accept", "application/json");

	const response = await net.fetch(url.toString(), {
		method: init.method ?? "GET",
		headers,
		body: init.body,
		session,
		credentials: "include",
	});

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

export async function fetchSelf(session: Session): Promise<FlowstokenUserSnapshot> {
	const data = await apiFetch<Record<string, unknown>>(session, "/api/user/self");
	return mapUser(data);
}

export async function loginWithPassword(
	session: Session,
	username: string,
	password: string,
	turnstileToken: string,
): Promise<FlowstokenUserSnapshot> {
	const url = new URL("/api/user/login", FLOWSTOKEN_API_ORIGIN);
	url.searchParams.set("turnstile", turnstileToken);
	const response = await net.fetch(url.toString(), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ username, password }),
		session,
		credentials: "include",
	});
	const json = (await response.json()) as ApiEnvelope<Record<string, unknown>>;
	if (!response.ok || json.success === false) {
		throw new FlowstokenApiError(json.message || "登录失败", response.status);
	}
	if (json.data) return mapUser(json.data);
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
