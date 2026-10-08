import { createHash } from "node:crypto";
import { net, type Session } from "electron";
import { mainT } from "../i18n/index.js";
import {
	createDesktopAuthorizationSession,
	disposeDesktopAuthorizationSession,
	mutateFlowstokenCookies,
	waitForFlowstokenCookieMutations,
} from "./auth-session.js";
import { FLOWSTOKEN_API_ORIGIN, FLOWSTOKEN_GROUPS } from "./constants.js";
import { isValidBillingGroupId } from "./group-catalog.js";
import type { FlowstokenUsageRow, FlowstokenUserSnapshot } from "./types.js";

interface ApiEnvelope<T> {
	success?: boolean;
	code?: string;
	message?: string;
	data?: T;
}

export class FlowstokenApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
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
let cachedUser: FlowstokenUserSnapshot | null = null;
let cachedSessionId: string | null = null;
let authRevision = 0;
const authChangedListeners = new Set<() => void>();
const requestCooldowns = new WeakMap<Session, number>();
let refreshRequest: {
	session: Session;
	revision: number;
	promise: Promise<{ accessToken: string; user: FlowstokenUserSnapshot }>;
	controller: AbortController;
	consumers: Set<symbol>;
} | null = null;
let logoutRequest: Promise<void> | null = null;

export function onFlowstokenAuthChanged(listener: () => void): () => void {
	authChangedListeners.add(listener);
	return () => {
		authChangedListeners.delete(listener);
	};
}

function advanceAuthRevision(): void {
	authRevision++;
	for (const listener of authChangedListeners) listener();
}

export function clearCachedAccessToken(): void {
	const pendingRefresh = refreshRequest;
	cachedAccessToken = null;
	cachedAccountId = null;
	cachedUser = null;
	cachedSessionId = null;
	advanceAuthRevision();
	pendingRefresh?.controller.abort(new FlowstokenApiError(mainT("flowstoken.errors.accountChanged")));
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

export function abortPendingFlowstokenRefresh(): void {
	refreshRequest?.controller.abort(new FlowstokenApiError(mainT("flowstoken.errors.accountChanged")));
}

/** Explicit sign-out only. Remote revocation is best effort; local sign-out always completes. */
export function logoutFlowstokenAuthSession(session: Session): Promise<void> {
	if (logoutRequest) return logoutRequest;
	const accessToken = cachedAccessToken;
	const sid = cachedSessionId;
	clearCachedAccessToken();
	const revision = authRevision;
	const task = mutateFlowstokenCookies(async () => {
		if (revision !== authRevision) return;
		let isolated: Session | undefined;
		try {
			if (sid) {
				const url = new URL("/api/user/auth/logout", FLOWSTOKEN_API_ORIGIN).toString();
				const cookies = await session.cookies.get({ url, name: "new_api_refresh" });
				if (revision !== authRevision) return;
				const headers = new Headers({
					Accept: "application/json",
					Origin: FLOWSTOKEN_API_ORIGIN,
					Referer: `${FLOWSTOKEN_API_ORIGIN}/`,
					"X-Auth-Session": sid,
				});
				if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
				const cookie = cookies.find(
					(entry) =>
						entry.name === "new_api_refresh" &&
						entry.domain === "www.flowstoken.com" &&
						entry.path === "/api/user/auth",
				);
				if (cookie) headers.set("Cookie", `new_api_refresh=${cookie.value}`);
				// A late logout response must not clear a newer formal cookie via Set-Cookie.
				isolated = createDesktopAuthorizationSession();
				const controller = new AbortController();
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timeout = new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						controller.abort();
						resolve();
					}, 5_000);
				});
				const revocationSession = isolated;
				const request = Promise.resolve()
					.then(() =>
						revocationSession.fetch(url, {
							method: "POST",
							headers,
							credentials: "include",
							redirect: "error",
							signal: controller.signal,
						}),
					)
					.then((response) => {
						if (response.status === 429) recordRateLimit(session, response);
						void response.body?.cancel().catch(() => {});
					})
					.catch(() => {});
				try {
					await Promise.race([request, timeout]);
				} finally {
					clearTimeout(timer);
					controller.abort();
				}
			}
		} catch {
			// An unavailable network or cookie read must not prevent local sign-out.
		} finally {
			if (isolated) void disposeDesktopAuthorizationSession(isolated);
			if (revision === authRevision) await session.clearStorageData({ storages: ["cookies", "localstorage"] });
		}
	});
	const tracked = task.finally(() => {
		if (logoutRequest === tracked) logoutRequest = null;
	});
	logoutRequest = tracked;
	return tracked;
}

/** Display-only fallback; it never grants model entitlements or replaces their authenticated checks. */
export function getCachedFlowstokenUser(): FlowstokenUserSnapshot | null {
	return cachedUser ? { ...cachedUser } : null;
}

export function getFlowstokenRequestCooldownMs(session: Session): number {
	return Math.max(0, (requestCooldowns.get(session) ?? 0) - Date.now());
}

function rateLimitError(session: Session): FlowstokenApiError {
	const retryAfterMs = getFlowstokenRequestCooldownMs(session);
	return new FlowstokenApiError(
		mainT("flowstoken.errors.rateLimited", { seconds: Math.ceil(retryAfterMs / 1000) }),
		429,
		retryAfterMs,
	);
}

export function assertFlowstokenRequestAllowed(session: Session): void {
	if (getFlowstokenRequestCooldownMs(session) > 0) throw rateLimitError(session);
}

function recordRateLimit(session: Session, response: Response): void {
	const value = response.headers.get("Retry-After")?.trim();
	const parsed = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : NaN;
	const delay = Number.isSafeInteger(parsed) && parsed >= 0 ? Math.max(1000, parsed) : 60_000;
	requestCooldowns.set(session, Math.max(requestCooldowns.get(session) ?? 0, Date.now() + delay));
}

export function setCachedAccessToken(token: string | null | undefined): void {
	const trimmed = typeof token === "string" ? token.trim() : "";
	cachedAccessToken = trimmed || null;
	cachedAccountId = null;
	cachedUser = null;
	cachedSessionId = null;
	advanceAuthRevision();
}

function assertCurrentAuth(revision: number): void {
	if (revision !== authRevision) throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
}

type RefreshPayload = {
	access_token?: string;
	accessToken?: string;
	token?: string;
	user?: Record<string, unknown>;
	session?: { sid?: unknown };
} & Record<string, unknown>;

function sessionId(data: RefreshPayload | null | undefined): string | null {
	const sid = data?.session?.sid;
	return typeof sid === "string" && sid.length > 0 && sid.length <= 256 && !/[\u0000-\u0020\u007f]/.test(sid)
		? sid
		: null;
}

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

export interface DesktopAuthorizationBundle {
	readonly accessToken: string;
	readonly sessionId: string;
	readonly user: FlowstokenUserSnapshot;
}

/** The authorization code is exchanged only over HTTPS in the app's own cookie session. */
export async function exchangeDesktopAuthorization(
	session: Session,
	input: { code: string; codeVerifier: string; redirectUri: string },
	options: { signal: AbortSignal; revision: number; rateLimitSession?: Session },
): Promise<DesktopAuthorizationBundle> {
	assertCurrentAuth(options.revision);
	if (options.rateLimitSession) assertFlowstokenRequestAllowed(options.rateLimitSession);
	const response = await sessionFetch(
		session,
		new URL("/api/user/auth/desktop/exchange", FLOWSTOKEN_API_ORIGIN).toString(),
		{
			method: "POST",
			signal: options.signal,
			redirect: "error",
			headers: { Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-store" },
			body: JSON.stringify({
				client_id: "flowstoken-desktop",
				code: input.code,
				code_verifier: input.codeVerifier,
				redirect_uri: input.redirectUri,
			}),
		},
	).catch((error: unknown) => {
		if (options.rateLimitSession && error instanceof FlowstokenApiError && error.status === 429)
			requestCooldowns.set(
				options.rateLimitSession,
				Math.max(requestCooldowns.get(options.rateLimitSession) ?? 0, Date.now() + (error.retryAfterMs ?? 60_000)),
			);
		throw error;
	});
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed"), response.status);
	}
	options.signal.throwIfAborted();
	assertCurrentAuth(options.revision);
	if (
		!response.ok ||
		!value ||
		typeof value !== "object" ||
		!("success" in value) ||
		value.success !== true ||
		!("data" in value) ||
		!value.data ||
		typeof value.data !== "object"
	)
		throw new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed"), response.status);
	const data = value.data as RefreshPayload;
	const accessToken = pickAccessToken(data);
	if (!accessToken || !data.user || typeof data.user !== "object" || Array.isArray(data.user))
		throw new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed"), response.status);
	const sid = sessionId(data);
	if (!sid) throw new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed"), response.status);
	return { accessToken, sessionId: sid, user: mapUser(data.user) };
}

/** No asynchronous work may occur between the generation check and committing this verified bundle. */
export function acceptDesktopAuthorization(
	bundle: DesktopAuthorizationBundle,
	revision: number,
	signal: AbortSignal,
): FlowstokenUserSnapshot {
	signal.throwIfAborted();
	assertCurrentAuth(revision);
	const pendingRefresh = refreshRequest;
	cachedAccessToken = bundle.accessToken;
	cachedAccountId = bundle.user.id;
	cachedUser = { ...bundle.user };
	cachedSessionId = bundle.sessionId;
	advanceAuthRevision();
	pendingRefresh?.controller.abort(new FlowstokenApiError(mainT("flowstoken.errors.accountChanged")));
	return { ...bundle.user };
}

async function sessionFetch(session: Session, url: string, init: RequestInit): Promise<Response> {
	assertFlowstokenRequestAllowed(session);
	const revision = authRevision;
	const controller = new AbortController();
	const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
	signal.throwIfAborted();
	let onAbort: (() => void) | undefined;
	const canceled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new FlowstokenApiError(mainT("flowstoken.errors.requestTimeout"));
			controller.abort(error);
			reject(error);
		}, 15_000);
	});
	const request = (async () => {
		await waitForFlowstokenCookieMutations(session);
		assertCurrentAuth(revision);
		signal.throwIfAborted();
		const headers = new Headers(init.headers);
		const path = new URL(url).pathname;
		if (cachedSessionId && ["/api/user/auth/refresh", "/api/user/auth/logout"].includes(path))
			headers.set("X-Auth-Session", cachedSessionId);
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
		signal.throwIfAborted();
		assertFlowstokenRequestAllowed(session);

		if (!headers.has("Origin")) {
			headers.set("Origin", FLOWSTOKEN_API_ORIGIN);
		}
		if (!headers.has("Referer")) {
			headers.set("Referer", `${FLOWSTOKEN_API_ORIGIN}/`);
		}

		const options = {
			...init,
			headers,
			signal,
			credentials: init.credentials ?? "include",
		};
		const response =
			typeof session.fetch === "function"
				? await session.fetch(url, options)
				: await net.fetch(url, { ...options, ...({ session } as object) } as RequestInit);
		signal.throwIfAborted();
		if (response.status === 429) {
			recordRateLimit(session, response);
			void response.body?.cancel().catch(() => {});
			throw rateLimitError(session);
		}
		const body = await response.arrayBuffer();
		signal.throwIfAborted();
		assertCurrentAuth(revision);
		return new Response([204, 205, 304].includes(response.status) ? null : body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	})();
	try {
		return await Promise.race([request, expired, canceled]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function performRefresh(
	session: Session,
	revision: number,
	signal: AbortSignal,
): Promise<{
	accessToken: string;
	user: FlowstokenUserSnapshot;
}> {
	const url = new URL("/api/user/auth/refresh", FLOWSTOKEN_API_ORIGIN).toString();
	const response = await sessionFetch(session, url, {
		method: "POST",
		signal,
		headers: {
			Accept: "application/json",
			"Cache-Control": "no-store",
		},
	});

	const text = await response.text();
	signal.throwIfAborted();
	assertCurrentAuth(revision);
	if (response.status === 401) {
		// An already signed-out background probe must not cancel a browser authorization in progress.
		if (cachedAccessToken !== null || cachedAccountId !== null || cachedUser !== null || cachedSessionId !== null)
			clearCachedAccessToken();
		throw new FlowstokenApiError(mainT("flowstoken.errors.authRequired"), 401);
	}
	let json: ApiEnvelope<RefreshPayload> | null = null;
	try {
		json = text ? (JSON.parse(text) as ApiEnvelope<RefreshPayload>) : null;
	} catch {
		throw new FlowstokenApiError(`刷新会话响应不是 JSON（HTTP ${response.status}）`, response.status);
	}

	if (!response.ok || json?.success === false) {
		if (response.status === 409 && json?.code === "AUTH_SESSION_MISMATCH")
			throw new FlowstokenApiError(mainT("flowstoken.errors.sessionMismatch"), 409);
		throw new FlowstokenApiError(json?.message || `刷新会话失败（HTTP ${response.status}）`, response.status);
	}

	const data = (json?.data ?? null) as RefreshPayload | null;
	const accessToken = pickAccessToken(data);
	if (!accessToken) {
		throw new FlowstokenApiError("刷新会话未返回 access_token", response.status);
	}
	let user: FlowstokenUserSnapshot;
	if (data?.user && typeof data.user === "object") {
		user = mapUser(data.user);
	} else if (data && data.id !== undefined) {
		user = mapUser(data);
	} else {
		user = await fetchSelfWithBearer(session, accessToken, revision, false, signal);
	}
	signal.throwIfAborted();
	assertCurrentAuth(revision);
	const sameAccount = cachedAccountId === user.id;
	if (cachedAccountId !== null && !sameAccount) advanceAuthRevision();
	cachedAccessToken = accessToken;
	cachedAccountId = user.id;
	cachedUser = user;
	cachedSessionId = sessionId(data) ?? (sameAccount ? cachedSessionId : null);
	return { accessToken, user };
}

export function refreshAuth(
	session: Session,
	options: { signal?: AbortSignal } = {},
): Promise<{ accessToken: string; user: FlowstokenUserSnapshot }> {
	if (options.signal?.aborted) return Promise.reject(options.signal.reason);
	if (
		refreshRequest?.session !== session ||
		refreshRequest.revision !== authRevision ||
		refreshRequest.controller.signal.aborted
	) {
		const revision = authRevision;
		const controller = new AbortController();
		const promise = performRefresh(session, revision, controller.signal).finally(() => {
			if (refreshRequest?.promise === promise) refreshRequest = null;
		});
		refreshRequest = { session, revision, promise, controller, consumers: new Set() };
	}
	const request = refreshRequest;
	const consumer = Symbol();
	request.consumers.add(consumer);
	return new Promise((resolve, reject) => {
		const finish = () => {
			request.consumers.delete(consumer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			finish();
			if (request.consumers.size === 0) request.controller.abort(options.signal?.reason);
			reject(options.signal?.reason);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		request.promise.then(
			(value) => {
				finish();
				resolve(value);
			},
			(error: unknown) => {
				finish();
				reject(error);
			},
		);
	});
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
	signal?: AbortSignal,
): Promise<FlowstokenUserSnapshot> {
	assertCurrentAuth(revision);
	const url = new URL("/api/user/self", FLOWSTOKEN_API_ORIGIN).toString();
	const response = await sessionFetch(session, url, {
		method: "GET",
		signal,
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
		if (cachedAccountId !== null && cachedAccountId !== user.id) {
			cachedSessionId = null;
			advanceAuthRevision();
		}
		cachedAccountId = user.id;
		cachedUser = user;
	}
	return user;
}

export async function fetchSelf(session: Session): Promise<FlowstokenUserSnapshot> {
	const revision = authRevision;
	try {
		return (await refreshAuth(session)).user;
	} catch (refreshError) {
		if (refreshError instanceof FlowstokenApiError && [401, 409].includes(refreshError.status ?? 0))
			throw refreshError;
		assertCurrentAuth(revision);
		if (refreshError instanceof FlowstokenApiError && refreshError.status === 429) throw refreshError;
		if (cachedAccessToken) {
			try {
				return await fetchSelfWithBearer(session, cachedAccessToken, revision);
			} catch (error) {
				assertCurrentAuth(revision);
				if (error instanceof FlowstokenApiError && error.status === 401) {
					clearCachedAccessToken();
					throw error;
				}
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
		cachedUser = user;
		cachedSessionId = sessionId(json.data);
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
