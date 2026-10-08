import type { ModelCredentialRequest } from "@vetta/action-rpc";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelsConfig } from "../models/model-settings-service.js";

const state = vi.hoisted(() => ({
	config: { providers: {} } as ModelsConfig,
	revision: 1,
	key: "fixture-key" as string | undefined,
	validate: vi.fn(),
}));
vi.mock("../models/model-settings-service.js", () => ({ readModelsConfigSync: () => structuredClone(state.config) }));
vi.mock("./newapi-client.js", () => ({ getFlowstokenAuthRevision: () => state.revision }));
vi.mock("./managed-credentials.js", () => ({ resolveManagedApiKey: () => state.key }));
vi.mock("./catalog-access.js", () => ({ assertFlowstokenModelAccess: state.validate }));

import { resolveDesktopModelCredential } from "./credential-broker.js";

const request: ModelCredentialRequest = {
	providerId: "flowstoken-default",
	modelId: "fixture-chat",
	accountId: 7,
	groupId: "default",
	tokenId: 10,
	baseUrl: "https://fixture.invalid/v1",
};
beforeEach(() => {
	state.revision = 1;
	state.key = "fixture-key";
	state.config = {
		providers: {
			"flowstoken-default": {
				baseUrl: request.baseUrl,
				credentialRef: "preserved-legacy-ref",
				managedGroup: { source: "flowstoken", accountId: 7, groupId: "default", tokenId: 10 },
			},
		},
	};
	state.validate.mockReset().mockResolvedValue({
		assertCurrent: () => {},
		assertCredential: (key: string) => {
			if (key !== "fixture-key") throw new Error("Credential mismatch");
		},
	});
});

it("supplies only the current managed key after model access validation", async () => {
	expect(await resolveDesktopModelCredential(request)).toEqual({
		apiKey: "fixture-key",
		authRevision: 1,
		accountId: 7,
		groupId: "default",
		tokenId: 10,
	});
	expect(state.validate).toHaveBeenCalledWith(
		request.providerId,
		request.modelId,
		state.config.providers[request.providerId].managedGroup,
		undefined,
		{ baseUrl: request.baseUrl, headers: undefined },
	);
	expect(state.config.providers[request.providerId].credentialRef).toBe("preserved-legacy-ref");
});

it.each([
	{ accountId: 8 },
	{ tokenId: 11 },
	{ groupId: "vip" },
	{ baseUrl: "https://other.invalid" },
	{ providerId: "custom" },
])("rejects changed account, token, group, destination or provider: %j", async (change) => {
	await expect(resolveDesktopModelCredential({ ...request, ...change })).rejects.toMatchObject({
		code: "MODEL_CREDENTIAL_STALE",
	});
	expect(state.validate).not.toHaveBeenCalled();
});

it("rejects logout while authorization is in flight", async () => {
	state.validate.mockImplementation(async () => {
		state.revision += 1;
		return { assertCurrent: () => {} };
	});
	await expect(resolveDesktopModelCredential(request)).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_STALE" });
});

it("keeps an admitted credential valid when only catalog display metadata refreshes", async () => {
	const assertCurrent = vi.fn();
	state.validate.mockImplementation(async () => {
		const provider = state.config.providers[request.providerId];
		provider.modelsSyncedAt = "2026-10-07T00:00:00.000Z";
		provider.displayName = "Updated group title";
		provider.models = [{ id: request.modelId!, name: "Updated model title" }];
		return { assertCurrent };
	});
	await expect(resolveDesktopModelCredential(request)).resolves.toMatchObject({ apiKey: "fixture-key" });
	expect(assertCurrent).toHaveBeenCalled();
});

it.each(["account", "group", "token", "override", "baseUrl", "headers", "api", "authHeader"])(
	"rejects a credential routing or binding change during authorization: %s",
	async (change) => {
		state.validate.mockImplementation(async () => {
			const provider = state.config.providers[request.providerId];
			if (change === "account") provider.managedGroup!.accountId = 8;
			else if (change === "group") provider.managedGroup!.groupId = "vip";
			else if (change === "token") provider.managedGroup!.tokenId = 11;
			else if (change === "override") provider.managedGroupOverride = true;
			else if (change === "baseUrl") provider.baseUrl = "https://changed.invalid/v1";
			else if (change === "headers") provider.headers = { "X-Route": "changed" };
			else if (change === "api") provider.api = "anthropic-messages";
			else provider.authHeader = false;
			return { assertCurrent: () => {} };
		});
		await expect(resolveDesktopModelCredential(request)).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_STALE" });
	},
);

it("still checks an access lease revoked after catalog metadata changed", async () => {
	state.validate.mockImplementation(async () => {
		state.config.providers[request.providerId].displayName = "Updated title";
		return {
			assertCurrent: () => {
				throw new Error("Model permission revoked");
			},
		};
	});
	await expect(resolveDesktopModelCredential(request)).rejects.toThrow("Model permission revoked");
});

it("does not supply a key when model permission is denied or the session key is missing", async () => {
	state.validate.mockRejectedValueOnce(new Error("Permission revoked"));
	await expect(resolveDesktopModelCredential(request)).rejects.toThrow("Permission revoked");
	state.key = undefined;
	await expect(resolveDesktopModelCredential(request)).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_UNAVAILABLE" });
});
