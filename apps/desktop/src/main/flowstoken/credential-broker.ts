import { ActionRpcError, type ModelCredentialRequest, type ModelCredentialResponse } from "@vetta/action-rpc";
import { type ProviderConfig, readModelsConfigSync } from "../models/model-settings-service.js";
import { assertFlowstokenModelAccess } from "./catalog-access.js";
import { resolveManagedApiKey } from "./managed-credentials.js";
import { getFlowstokenAuthRevision } from "./newapi-client.js";

/** Display/catalog refreshes do not change the authority for an already admitted request. */
function credentialRoutingIdentity(provider: ProviderConfig | undefined): string | undefined {
	if (!provider) return undefined;
	return JSON.stringify({
		managedGroup: provider.managedGroup,
		managedGroupOverride: provider.managedGroupOverride === true,
		baseUrl: provider.baseUrl,
		api: provider.api,
		authHeader: provider.authHeader,
		headers: Object.entries(provider.headers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
	});
}

/** Used only behind the authenticated loopback RPC server; no credential values are logged. */
export async function resolveDesktopModelCredential(request: ModelCredentialRequest): Promise<ModelCredentialResponse> {
	const provider = readModelsConfigSync().providers[request.providerId];
	const binding = provider?.managedGroup;
	if (
		!binding ||
		provider.managedGroupOverride ||
		binding.source !== "flowstoken" ||
		binding.accountId !== request.accountId ||
		binding.groupId !== request.groupId ||
		binding.tokenId !== request.tokenId ||
		provider.baseUrl !== request.baseUrl
	) {
		throw new ActionRpcError("MODEL_CREDENTIAL_STALE", "Managed model credential binding has changed");
	}
	const revision = getFlowstokenAuthRevision();
	const lease = await assertFlowstokenModelAccess(
		request.providerId,
		request.modelId,
		binding,
		request.modelSourceId,
		{
			baseUrl: request.baseUrl,
			headers: request.headers ?? provider.headers,
		},
	);
	const current = readModelsConfigSync().providers[request.providerId];
	if (
		revision !== getFlowstokenAuthRevision() ||
		credentialRoutingIdentity(current) !== credentialRoutingIdentity(provider)
	) {
		throw new ActionRpcError("MODEL_CREDENTIAL_STALE", "Managed model credential binding has changed");
	}
	const apiKey = resolveManagedApiKey(current);
	if (!apiKey || !lease)
		throw new ActionRpcError("MODEL_CREDENTIAL_UNAVAILABLE", "Managed model credentials are unavailable");
	lease.assertCurrent();
	lease.assertCredential?.(apiKey);
	return {
		apiKey,
		authRevision: revision,
		accountId: binding.accountId,
		groupId: binding.groupId,
		tokenId: binding.tokenId,
	};
}
