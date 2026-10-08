import type { ProviderConfig } from "../models/model-settings-service.js";
import { getFlowstokenAccountId, getFlowstokenAuthRevision, onFlowstokenAuthChanged } from "./newapi-client.js";

export interface ManagedCredential {
	readonly revision: number;
	readonly accountId: number;
	readonly groupId: string;
	readonly tokenId: number;
	readonly key: string;
}

export type ManagedCredentialProvider = Pick<ProviderConfig, "managedGroup" | "managedGroupOverride">;

const credentials = new Map<string, ManagedCredential>();
const listeners = new Set<() => void>();

function notifyChanged(): void {
	for (const listener of listeners) listener();
}

/** Account keys are reacquired from the authenticated API, never restored from the legacy vault. */
export function rememberManagedCredential(credential: ManagedCredential): void {
	if (
		credential.revision !== getFlowstokenAuthRevision() ||
		credential.accountId !== getFlowstokenAccountId() ||
		!Number.isSafeInteger(credential.tokenId) ||
		credential.tokenId <= 0 ||
		!credential.groupId ||
		!credential.key
	)
		throw new Error("Managed credential does not belong to the active account session");
	credentials.set(credential.groupId, { ...credential });
	notifyChanged();
}

export function isManagedCredentialProvider(provider: ManagedCredentialProvider): boolean {
	return provider.managedGroup?.source === "flowstoken" && provider.managedGroupOverride !== true;
}

/** No TTL: authorization freshness belongs to catalog-access; these keys live for this account session. */
export function resolveManagedApiKey(provider: ManagedCredentialProvider): string | undefined {
	if (!isManagedCredentialProvider(provider)) return undefined;
	const binding = provider.managedGroup;
	if (!binding) return undefined;
	const credential = credentials.get(binding.groupId);
	if (
		!credential ||
		credential.revision !== getFlowstokenAuthRevision() ||
		credential.accountId !== getFlowstokenAccountId() ||
		credential.accountId !== binding.accountId ||
		credential.tokenId !== binding.tokenId
	)
		return undefined;
	return credential.key;
}

export function onManagedCredentialsChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

onFlowstokenAuthChanged(() => {
	credentials.clear();
	notifyChanged();
});
