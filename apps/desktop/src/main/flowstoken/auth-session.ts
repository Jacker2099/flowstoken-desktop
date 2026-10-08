import { randomUUID } from "node:crypto";
import { type Cookie, type CookiesSetDetails, session as electronSession, type Session } from "electron";
import { FLOWSTOKEN_API_ORIGIN, FLOWSTOKEN_SESSION_PARTITION } from "./constants.js";

const REFRESH_COOKIE_NAME = "new_api_refresh";
const REFRESH_COOKIE_PATH = "/api/user/auth";
const REFRESH_COOKIE_URL = `${FLOWSTOKEN_API_ORIGIN}${REFRESH_COOKIE_PATH}`;
const primarySessions = new WeakSet<Session>();
let cookieMutation: Promise<void> = Promise.resolve();

export function getFlowstokenSession(): Session {
	const session = electronSession.fromPartition(FLOWSTOKEN_SESSION_PARTITION);
	primarySessions.add(session);
	return session;
}

export function createDesktopAuthorizationSession(): Session {
	return electronSession.fromPartition(`flowstoken-desktop-authorization-${randomUUID()}`, { cache: false });
}

export function mutateFlowstokenCookies<Result>(mutation: () => Promise<Result>): Promise<Result> {
	const next = cookieMutation.then(mutation, mutation);
	cookieMutation = next.then(
		() => {},
		() => {},
	);
	return next;
}

export function drainFlowstokenCookieMutations(): Promise<void> {
	return cookieMutation;
}

/** Refresh and other authenticated reads must not observe a partially imported authorization. */
export async function waitForFlowstokenCookieMutations(session: Session): Promise<void> {
	if (primarySessions.has(session)) await cookieMutation;
}

function officialRefreshCookie(cookie: Cookie): boolean {
	return (
		cookie.name === REFRESH_COOKIE_NAME &&
		cookie.domain === "www.flowstoken.com" &&
		cookie.hostOnly === true &&
		cookie.path === REFRESH_COOKIE_PATH
	);
}

function cookieDetails(cookie: Cookie): CookiesSetDetails {
	return {
		url: REFRESH_COOKIE_URL,
		name: REFRESH_COOKIE_NAME,
		value: cookie.value,
		path: REFRESH_COOKIE_PATH,
		secure: cookie.secure,
		httpOnly: cookie.httpOnly,
		sameSite: cookie.sameSite,
		...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
	};
}

/** Imports only the app-owned staging refresh cookie; browser cookies never enter this boundary. */
export function importDesktopAuthorizationCookie<Result>(
	staging: Session,
	options: {
		assertCurrent: () => void;
		shouldRestorePrevious: () => boolean;
		commit: () => Result;
	},
): Promise<Result> {
	return mutateFlowstokenCookies(async () => {
		options.assertCurrent();
		const candidates = (await staging.cookies.get({ url: REFRESH_COOKIE_URL })).filter(officialRefreshCookie);
		options.assertCurrent();
		const candidate = candidates[0];
		if (
			candidates.length !== 1 ||
			!candidate ||
			!candidate.value ||
			!candidate.secure ||
			!candidate.httpOnly ||
			candidate.sameSite !== "strict"
		)
			throw new Error("DESKTOP_AUTH_REFRESH_COOKIE_INVALID");
		const formal = getFlowstokenSession();
		const previous = (await formal.cookies.get({ url: REFRESH_COOKIE_URL })).find(officialRefreshCookie);
		options.assertCurrent();
		try {
			await formal.cookies.set(cookieDetails(candidate));
			options.assertCurrent();
			return options.commit();
		} catch (error) {
			const written = (await formal.cookies.get({ url: REFRESH_COOKIE_URL })).find(officialRefreshCookie);
			if (written?.value === candidate.value) {
				await formal.cookies.remove(REFRESH_COOKIE_URL, REFRESH_COOKIE_NAME);
				if (previous && options.shouldRestorePrevious()) await formal.cookies.set(cookieDetails(previous));
			}
			throw error;
		}
	});
}

export async function disposeDesktopAuthorizationSession(session: Session): Promise<void> {
	await session.closeAllConnections().catch(() => {});
	await session.clearStorageData().catch(() => {});
}
