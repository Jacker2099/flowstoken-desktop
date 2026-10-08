import type { Cookie, CookiesSetDetails, Session } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import {
	drainFlowstokenCookieMutations,
	getFlowstokenSession,
	importDesktopAuthorizationCookie,
	mutateFlowstokenCookies,
	waitForFlowstokenCookieMutations,
} from "./auth-session.js";

const boundary = vi.hoisted(() => ({ formal: undefined as unknown as Session }));
vi.mock("electron", () => ({ session: { fromPartition: () => boundary.formal } }));
const cookie = (value: string, change: Partial<Cookie> = {}): Cookie => ({
	name: "new_api_refresh",
	domain: "www.flowstoken.com",
	hostOnly: true,
	path: "/api/user/auth",
	secure: true,
	httpOnly: true,
	sameSite: "strict",
	session: false,
	expirationDate: 9_999_999_999,
	value,
	...change,
});
let stored: Cookie | undefined;
let set: ReturnType<typeof vi.fn<(details: CookiesSetDetails) => Promise<void>>>;
beforeEach(async () => {
	await drainFlowstokenCookieMutations();
	stored = cookie("old-session");
	set = vi.fn(async (details) => {
		stored = cookie(details.value ?? "");
	});
	boundary.formal = {
		cookies: {
			get: async () => (stored ? [{ ...stored }] : []),
			set,
			remove: async () => {
				stored = undefined;
			},
		},
	} as unknown as Session;
	getFlowstokenSession();
});
function staging(value: string, change: Partial<Cookie> = {}): Session {
	return { cookies: { get: async () => [cookie(value, change)] } } as unknown as Session;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it.each([
	{ domain: "flowstoken.com" },
	{ domain: ".www.flowstoken.com" },
	{ hostOnly: false },
	{ path: "/" },
	{ secure: false },
	{ httpOnly: false },
	{ sameSite: "lax" as const },
	{ name: "other_cookie" },
])("rejects a cookie outside the authenticated refresh-cookie contract: %j", async (change) => {
	const commit = vi.fn();
	await expect(
		importDesktopAuthorizationCookie(staging("new-session", change), {
			assertCurrent: () => {},
			shouldRestorePrevious: () => true,
			commit,
		}),
	).rejects.toThrow("DESKTOP_AUTH_REFRESH_COOKIE_INVALID");
	expect(set).not.toHaveBeenCalled();
	expect(commit).not.toHaveBeenCalled();
	expect(stored?.value).toBe("old-session");
});

it("restores the previous cookie when cancellation arrives while native cookies.set is pending", async () => {
	const controller = new AbortController();
	const started = deferred<void>();
	const release = deferred<void>();
	set.mockImplementationOnce(async (details) => {
		started.resolve();
		await release.promise;
		stored = cookie(details.value ?? "");
	});
	const commit = vi.fn();
	const imported = importDesktopAuthorizationCookie(staging("canceled-session"), {
		assertCurrent: () => controller.signal.throwIfAborted(),
		shouldRestorePrevious: () => true,
		commit,
	});
	void imported.catch(() => {});
	await started.promise;
	let readPassed = false;
	const reading = waitForFlowstokenCookieMutations(boundary.formal).then(() => {
		readPassed = true;
	});
	await Promise.resolve();
	expect(readPassed).toBe(false);
	controller.abort(new Error("fixture canceled"));
	release.resolve();
	await expect(imported).rejects.toThrow("fixture canceled");
	await reading;
	expect(stored?.value).toBe("old-session");
	expect(commit).not.toHaveBeenCalled();
});

it("serializes logout and the next login after rollback without clearing the newer authorized cookie", async () => {
	const first = new AbortController();
	let revision = 1;
	const started = deferred<void>();
	const release = deferred<void>();
	set.mockImplementationOnce(async (details) => {
		started.resolve();
		await release.promise;
		stored = cookie(details.value ?? "");
	});
	const oldCommit = vi.fn();
	const newCommit = vi.fn(() => "new-account");
	const imported = importDesktopAuthorizationCookie(staging("late-old-session"), {
		assertCurrent: () => {
			first.signal.throwIfAborted();
			if (revision !== 1) throw new Error("account changed");
		},
		shouldRestorePrevious: () => revision === 1,
		commit: oldCommit,
	});
	void imported.catch(() => {});
	await started.promise;
	first.abort(new Error("logout"));
	revision = 2;
	const logout = mutateFlowstokenCookies(async () => {
		stored = undefined;
	});
	const nextLogin = importDesktopAuthorizationCookie(staging("next-successful-session"), {
		assertCurrent: () => {
			if (revision !== 2) throw new Error("changed");
		},
		shouldRestorePrevious: () => true,
		commit: newCommit,
	});
	release.resolve();
	await expect(imported).rejects.toThrow("logout");
	await logout;
	expect(await nextLogin).toBe("new-account");
	expect(stored?.value).toBe("next-successful-session");
	expect(oldCommit).not.toHaveBeenCalled();
	expect(newCommit).toHaveBeenCalledOnce();
});

it("does not overwrite a different cookie observed during rollback", async () => {
	const controller = new AbortController();
	set.mockImplementationOnce(async () => {
		stored = cookie("newer-external-session");
		controller.abort(new Error("canceled"));
	});
	await expect(
		importDesktopAuthorizationCookie(staging("candidate-session"), {
			assertCurrent: () => controller.signal.throwIfAborted(),
			shouldRestorePrevious: () => true,
			commit: vi.fn(),
		}),
	).rejects.toThrow("canceled");
	expect(stored?.value).toBe("newer-external-session");
});
