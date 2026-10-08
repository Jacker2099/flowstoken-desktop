import {
	type ModelCredentialRequest,
	parseLocalRpcRequest,
	resolveModelCredential,
	startLocalRpcServer,
} from "@vetta/action-rpc";
import { afterEach, expect, it, vi } from "vitest";

const request: ModelCredentialRequest = {
	providerId: "flowstoken-default",
	modelId: "fixture-chat",
	accountId: 7,
	groupId: "default",
	tokenId: 10,
	baseUrl: "https://fixture.invalid/v1",
};
const credential = { apiKey: "fixture-memory-only", authRevision: 1, accountId: 7, groupId: "default", tokenId: 10 };
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("requires loopback authentication before supplying credentials and marks the response no-store", async () => {
	const resolveCredential = vi.fn(async () => credential);
	const server = await startLocalRpcServer(
		{
			actions: { search: () => [], describe: () => ({}), run: () => ({}) },
			models: { resolveCredential },
		},
		{ token: "fixture-authentication", host: "127.0.0.1", port: 0 },
	);
	try {
		const denied = await fetch(`${server.endpoint.url}/rpc`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "denied", method: "models.resolveCredential", params: request }),
		});
		expect(await denied.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
		expect(denied.headers.get("cache-control")).toBe("no-store");
		expect(resolveCredential).not.toHaveBeenCalled();
		expect(await resolveModelCredential(server.endpoint, request)).toEqual(credential);
		expect(resolveCredential).toHaveBeenCalledOnce();
	} finally {
		await server.close();
	}
});

it.each(["https://example.com", "http://192.168.1.2", "http://127.0.0.1@evil.invalid", "http://user:pass@127.0.0.1"])(
	"never sends the local token to a non-loopback credential endpoint: %s",
	async (url) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(resolveModelCredential({ transport: "http", url, token: "fixture" }, request)).rejects.toMatchObject(
			{ code: "INVALID_ENDPOINT" },
		);
		expect(fetch).not.toHaveBeenCalled();
	},
);

it("rejects a mismatched credential response and disables redirects", async () => {
	const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
		const sent = JSON.parse(String(init.body)) as { id: string };
		return Response.json({ id: sent.id, ok: true, result: { ...credential, accountId: 8 } });
	});
	vi.stubGlobal("fetch", fetch);
	await expect(
		resolveModelCredential({ transport: "http", url: "http://127.0.0.1:12345", token: "fixture" }, request),
	).rejects.toMatchObject({ code: "INVALID_CREDENTIAL_RESPONSE" });
	expect(fetch).toHaveBeenCalledWith(
		expect.any(URL),
		expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
	);
});

it.each([{ accountId: "7" }, { tokenId: -1 }, { groupId: "" }, { headers: { Authorization: 5 } }])(
	"rejects malformed credential input before dispatch: %j",
	(change) => {
		expect(() =>
			parseLocalRpcRequest({ id: "fixture", method: "models.resolveCredential", params: { ...request, ...change } }),
		).toThrow();
	},
);
