import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { app, shell } from "electron";
import { mainT } from "../i18n/index.js";
import {
	createDesktopAuthorizationSession,
	disposeDesktopAuthorizationSession,
	importDesktopAuthorizationCookie,
} from "./auth-session.js";
import { FLOWSTOKEN_SITE_URL } from "./constants.js";
import { getFlowstokenSession } from "./login-window.js";
import {
	abortPendingFlowstokenRefresh,
	acceptDesktopAuthorization,
	assertFlowstokenRequestAllowed,
	exchangeDesktopAuthorization,
	FlowstokenApiError,
	getFlowstokenAuthRevision,
	onFlowstokenAuthChanged,
} from "./newapi-client.js";
import type { FlowstokenUserSnapshot } from "./types.js";

const CALLBACK_PATH = "/flowstoken/callback";
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
let active: { promise: Promise<FlowstokenUserSnapshot>; cancel: () => void } | null = null;

function html(response: ServerResponse, status: number, message: string): void {
	const escaped = message.replace(
		/[&<>"']/g,
		(value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!,
	);
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		"X-Content-Type-Options": "nosniff",
		Connection: "close",
	});
	response.end(
		`<!doctype html><html><head><meta charset="utf-8"><title>FlowsToken</title></head><body><p>${escaped}</p></body></html>`,
	);
}

export function cancelSystemBrowserLogin(): void {
	active?.cancel();
}

/** One app-owned, one-use callback listener; the system browser owns all password and website-cookie handling. */
export function loginViaSystemBrowser(): Promise<FlowstokenUserSnapshot> {
	if (active) return active.promise;
	const session = getFlowstokenSession();
	try {
		assertFlowstokenRequestAllowed(session);
	} catch (error) {
		return Promise.reject(error);
	}
	const revision = getFlowstokenAuthRevision();
	const staging = createDesktopAuthorizationSession();
	let state = randomBytes(32).toString("base64url");
	let verifier = randomBytes(32).toString("base64url");
	const controller = new AbortController();
	const listenerController = new AbortController();
	let cancel = () => {};
	const promise = new Promise<FlowstokenUserSnapshot>((resolve, reject) => {
		let settled = false;
		let consumed = false;
		let authorizationAccepted = false;
		let redirectUri = "";
		let expectedHost = "";
		let unsubscribe = () => {};
		const server = createServer((request, response) => {
			if (settled) {
				html(response, 410, mainT("flowstoken.errors.loginCancelled"));
				return;
			}
			if (request.method !== "GET" || request.headers.host !== expectedHost || !request.url?.startsWith("/")) {
				html(response, 403, mainT("flowstoken.errors.desktopCallbackInvalid"));
				return;
			}
			let url: URL;
			try {
				url = new URL(request.url, redirectUri);
			} catch {
				html(response, 400, mainT("flowstoken.errors.desktopCallbackInvalid"));
				return;
			}
			const receivedState = url.searchParams.get("state") ?? "";
			if (
				url.pathname !== CALLBACK_PATH ||
				url.searchParams.getAll("state").length !== 1 ||
				!/^[A-Za-z0-9_-]{43}$/.test(receivedState) ||
				receivedState.length !== state.length ||
				!timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
			) {
				html(response, 403, mainT("flowstoken.errors.desktopCallbackInvalid"));
				return;
			}
			if (consumed) {
				html(response, 409, mainT("flowstoken.errors.desktopCallbackInvalid"));
				return;
			}
			if (url.searchParams.get("error") === "access_denied") {
				if ([...url.searchParams.keys()].some((key) => key !== "state" && key !== "error")) {
					html(response, 400, mainT("flowstoken.errors.desktopCallbackInvalid"));
					return;
				}
				consumed = true;
				html(response, 200, mainT("flowstoken.errors.loginCancelled"));
				finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.loginCancelled")) }, true);
				return;
			}
			const code = url.searchParams.get("code") ?? "";
			if (
				!/^[A-Za-z0-9_-]{43}$/.test(code) ||
				url.searchParams.getAll("code").length !== 1 ||
				[...url.searchParams.keys()].some((key) => key !== "state" && key !== "code")
			) {
				html(response, 400, mainT("flowstoken.errors.desktopCallbackInvalid"));
				return;
			}
			consumed = true;
			void (async () => {
				try {
					const bundle = await exchangeDesktopAuthorization(
						staging,
						{ code, codeVerifier: verifier, redirectUri },
						{ signal: controller.signal, revision, rateLimitSession: session },
					);
					controller.signal.throwIfAborted();
					if (settled) return;
					abortPendingFlowstokenRefresh();
					const user = await importDesktopAuthorizationCookie(staging, {
						assertCurrent: () => {
							controller.signal.throwIfAborted();
							if (getFlowstokenAuthRevision() !== revision)
								throw new FlowstokenApiError(mainT("flowstoken.errors.accountChanged"));
						},
						shouldRestorePrevious: () => getFlowstokenAuthRevision() === revision,
						commit: () => {
							unsubscribe();
							const accepted = acceptDesktopAuthorization(bundle, revision, controller.signal);
							authorizationAccepted = true;
							clearTimeout(timeout);
							return accepted;
						},
					});
					void import("../window-manager.js").then(({ showMainWindow }) => showMainWindow()).catch(() => {});
					html(response, 200, mainT("flowstoken.desktopAuthorizationComplete"));
					finish({ user }, true);
				} catch (error) {
					if (settled) return;
					const failure =
						error instanceof FlowstokenApiError
							? error
							: new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed"));
					html(response, 400, mainT("flowstoken.errors.desktopAuthorizationFailed"));
					finish({ error: failure }, true);
				}
			})();
		});
		const finish = (result: { user: FlowstokenUserSnapshot } | { error: Error }, graceful = false) => {
			if (settled) return;
			if (authorizationAccepted && "error" in result) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribe();
			app.removeListener("before-quit", cancel);
			if ("error" in result) controller.abort(result.error);
			listenerController.abort();
			if (!graceful) server.closeAllConnections();
			state = "";
			verifier = "";
			if ("error" in result) reject(result.error);
			else resolve(result.user);
		};
		cancel = () => finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.loginCancelled")) });
		const timeout = setTimeout(
			() => finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.loginTimedOut")) }),
			AUTHORIZATION_TIMEOUT_MS,
		);
		unsubscribe = onFlowstokenAuthChanged(() => {
			if (getFlowstokenAuthRevision() !== revision)
				finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.accountChanged")) });
		});
		app.once("before-quit", cancel);
		server.once("error", () =>
			finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed")) }),
		);
		server.listen({ host: "127.0.0.1", port: 0, signal: listenerController.signal }, () => {
			if (settled) return;
			const port = (server.address() as AddressInfo).port;
			if (port <= 1023) {
				finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed")) });
				return;
			}
			expectedHost = `127.0.0.1:${port}`;
			redirectUri = `http://${expectedHost}${CALLBACK_PATH}`;
			const authorize = new URL("/auth/desktop", FLOWSTOKEN_SITE_URL);
			for (const [key, value] of Object.entries({
				client_id: "flowstoken-desktop",
				redirect_uri: redirectUri,
				state,
				code_challenge: createHash("sha256").update(verifier).digest("base64url"),
				code_challenge_method: "S256",
			}))
				authorize.searchParams.set(key, value);
			void shell
				.openExternal(authorize.toString())
				.catch(() =>
					finish({ error: new FlowstokenApiError(mainT("flowstoken.errors.desktopAuthorizationFailed")) }),
				);
		});
	});
	const tracked = promise.finally(async () => {
		await disposeDesktopAuthorizationSession(staging);
		if (active?.promise === tracked) active = null;
	});
	active = { promise: tracked, cancel };
	return tracked;
}
