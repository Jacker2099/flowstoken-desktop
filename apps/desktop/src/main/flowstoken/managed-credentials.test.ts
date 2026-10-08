import type { Session } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { onManagedCredentialsChanged, rememberManagedCredential, resolveManagedApiKey } from "./managed-credentials.js";
import {
	clearCachedAccessToken,
	getFlowstokenAuthRevision,
	refreshAuth,
	setCachedAccessToken,
} from "./newapi-client.js";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));
vi.mock("../i18n/index.js", () => ({ mainT: (key: string) => key }));

function session(accountId: number): Session {
	return {
		cookies: { get: async () => [] },
		fetch: async () =>
			Response.json({ success: true, data: { access_token: "fixture-session", user: { id: accountId } } }),
	} as unknown as Session;
}

const provider = {
	managedGroup: { source: "flowstoken" as const, accountId: 8, groupId: "default", tokenId: 10 },
};

beforeEach(async () => {
	clearCachedAccessToken();
	await refreshAuth(session(8));
});
afterEach(() => {
	clearCachedAccessToken();
	vi.useRealTimers();
});

function remember(key = "fixture-managed-key"): void {
	rememberManagedCredential({ revision: getFlowstokenAuthRevision(), ...provider.managedGroup, key });
}

it("keeps a verified key for the account session beyond the permission cache TTL", () => {
	vi.useFakeTimers();
	remember();
	vi.advanceTimersByTime(120_000);
	expect(resolveManagedApiKey(provider)).toBe("fixture-managed-key");
});

it("never resolves a different account, group, token or manual override", () => {
	remember();
	for (const binding of [
		{ ...provider.managedGroup, accountId: 9 },
		{ ...provider.managedGroup, groupId: "vip" },
		{ ...provider.managedGroup, tokenId: 11 },
	])
		expect(resolveManagedApiKey({ managedGroup: binding })).toBeUndefined();
	expect(resolveManagedApiKey({ ...provider, managedGroupOverride: true })).toBeUndefined();
});

it("invalidates subscribers immediately on logout and never revives old keys after login", async () => {
	remember();
	let observed = "unchanged";
	const unsubscribe = onManagedCredentialsChanged(() => {
		observed = resolveManagedApiKey(provider) ?? "unavailable";
	});
	try {
		clearCachedAccessToken();
		expect(observed).toBe("unavailable");
		await refreshAuth(session(8));
		expect(resolveManagedApiKey(provider)).toBeUndefined();
		remember("fixture-new-key");
		expect(resolveManagedApiKey(provider)).toBe("fixture-new-key");
	} finally {
		unsubscribe();
	}
});

it("rejects late writes from the previous auth revision and account", async () => {
	const oldRevision = getFlowstokenAuthRevision();
	remember();
	setCachedAccessToken("fixture-account-switch");
	await refreshAuth(session(9));
	expect(resolveManagedApiKey(provider)).toBeUndefined();
	expect(() =>
		rememberManagedCredential({ ...provider.managedGroup, revision: oldRevision, key: "late-key" }),
	).toThrow();
	expect(resolveManagedApiKey(provider)).toBeUndefined();
});

it("replaces a rotated token without retaining a key under the old token identity", () => {
	remember();
	rememberManagedCredential({
		...provider.managedGroup,
		tokenId: 11,
		revision: getFlowstokenAuthRevision(),
		key: "rotated-key",
	});
	expect(resolveManagedApiKey(provider)).toBeUndefined();
	expect(resolveManagedApiKey({ managedGroup: { ...provider.managedGroup, tokenId: 11 } })).toBe("rotated-key");
});
