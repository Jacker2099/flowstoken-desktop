import { existsSync, readFileSync } from "node:fs";
import { type ModelCredentialRequest, readActionRpcEndpoint, resolveModelCredential } from "@vetta/action-rpc";
import type { CodingAgentAuthRuntime, createCodingAgentModelRuntime } from "@vetta/coding-agent/host-services";

type AccessPolicy = Pick<
	NonNullable<Parameters<typeof createCodingAgentModelRuntime>[1]>,
	"validateModelAccess" | "validateProviderAccess"
>;
interface AccessLease {
	assertCurrent(): void;
	assertCredential(credential: string | undefined): void;
}
interface ManagedProvider {
	accountId: number;
	groupId: string;
	tokenId: number;
	baseUrl: string;
	headers?: Record<string, string>;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable(): Error {
	return Object.assign(new Error("Desktop managed model credentials changed or are unavailable"), {
		code: "FLOWSTOKEN_CREDENTIAL_STALE",
	});
}

/** ADR-0145 identities; CLI cannot import the desktop app's catalog implementation. */
function isOfficialFlowstokenProviderId(providerId: string): boolean {
	if (["flowstoken-default", "flowstoken-normal", "flowstoken-smart", "flowstoken-official"].includes(providerId))
		return true;
	const prefix = "flowstoken-group-";
	const group = providerId.startsWith(prefix) ? providerId.slice(prefix.length) : "";
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(group) && !["default", "smart", "vip"].includes(group);
}

function initiallyManagedProviders(path: string): Set<string> {
	if (!existsSync(path)) return new Set();
	try {
		const config: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!record(config) || !record(config.providers)) return new Set();
		return new Set(
			Object.entries(config.providers)
				.filter(
					([, provider]) =>
						record(provider) &&
						record(provider.managedGroup) &&
						provider.managedGroup.source === "flowstoken" &&
						provider.managedGroupOverride !== true,
				)
				.map(([id]) => id),
		);
	} catch {
		// The model registry reports malformed configuration; no model is admitted here.
		return new Set();
	}
}

function readManagedProvider(path: string, providerId: string): ManagedProvider | "override" | undefined {
	if (!existsSync(path)) return undefined;
	const config: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!record(config) || !record(config.providers)) return undefined;
	const provider = config.providers[providerId];
	if (record(provider) && provider.managedGroupOverride === true) return "override";
	if (!record(provider) || !record(provider.managedGroup) || provider.managedGroup.source !== "flowstoken")
		return undefined;
	const { accountId, groupId, tokenId } = provider.managedGroup;
	if (
		typeof accountId !== "number" ||
		!Number.isSafeInteger(accountId) ||
		accountId <= 0 ||
		typeof tokenId !== "number" ||
		!Number.isSafeInteger(tokenId) ||
		tokenId <= 0 ||
		typeof groupId !== "string" ||
		!groupId ||
		typeof provider.baseUrl !== "string"
	)
		throw unavailable();
	let headers: Record<string, string> | undefined;
	if (provider.headers !== undefined) {
		if (!record(provider.headers)) throw unavailable();
		headers = {};
		for (const [key, value] of Object.entries(provider.headers)) {
			if (typeof value !== "string") throw unavailable();
			headers[key] = value;
		}
	}
	return { accountId, groupId, tokenId, baseUrl: provider.baseUrl, ...(headers ? { headers } : {}) };
}

/** Shared by Electron and Node CLI hosts; keys cross only the authenticated loopback RPC. */
export function createDesktopManagedModelAccess(options: {
	modelsJsonPath: string;
	authStorage: Pick<CodingAgentAuthRuntime, "setRuntimeApiKey" | "removeRuntimeApiKey">;
}): AccessPolicy {
	const managedProviders = initiallyManagedProviders(options.modelsJsonPath);
	const admitted = new Map<string, { binding: string; revision: number; key: string; sequence: number }>();
	const pending = new Map<string, Promise<AccessLease>>();
	const revokedAt = new Map<string, number>();
	let sequence = 0;
	const revoke = (providerId: string, requestSequence = ++sequence) => {
		admitted.delete(providerId);
		revokedAt.set(providerId, Math.max(revokedAt.get(providerId) ?? 0, requestSequence));
		options.authStorage.removeRuntimeApiKey(providerId);
	};

	const validate = async (
		providerId: string,
		actual?: Pick<ModelCredentialRequest, "modelId" | "modelSourceId" | "baseUrl" | "headers">,
	): Promise<AccessLease | undefined> => {
		let provider: ManagedProvider | "override" | undefined;
		try {
			provider = readManagedProvider(options.modelsJsonPath, providerId);
		} catch (error) {
			revoke(providerId);
			throw error;
		}
		if (provider === "override") {
			if (isOfficialFlowstokenProviderId(providerId)) {
				revoke(providerId);
				throw unavailable();
			}
			if (managedProviders.delete(providerId)) revoke(providerId);
			return undefined;
		}
		if (!provider) {
			if (managedProviders.has(providerId) || isOfficialFlowstokenProviderId(providerId)) {
				revoke(providerId);
				throw unavailable();
			}
			return undefined;
		}
		managedProviders.add(providerId);
		const request: ModelCredentialRequest = { providerId, ...provider, ...actual };
		const binding = JSON.stringify(provider);
		const signature = JSON.stringify({ provider, request });
		const inFlight = pending.get(signature);
		if (inFlight) return inFlight;
		const requestSequence = ++sequence;
		const previous = admitted.get(providerId);
		if (previous && previous.binding !== binding) revoke(providerId, requestSequence);
		const promise = (async (): Promise<AccessLease> => {
			const credential = await resolveModelCredential(await readActionRpcEndpoint(), request);
			if (requestSequence < (revokedAt.get(providerId) ?? 0)) throw unavailable();
			if (JSON.stringify(readManagedProvider(options.modelsJsonPath, providerId)) !== binding) throw unavailable();
			let current = admitted.get(providerId);
			if (
				current &&
				(credential.authRevision < current.revision ||
					(credential.authRevision === current.revision &&
						credential.apiKey !== current.key &&
						requestSequence < current.sequence))
			)
				throw unavailable();
			if (
				!current ||
				current.binding !== binding ||
				current.revision !== credential.authRevision ||
				current.key !== credential.apiKey
			) {
				current = { binding, revision: credential.authRevision, key: credential.apiKey, sequence: requestSequence };
				admitted.set(providerId, current);
			} else current.sequence = Math.max(current.sequence, requestSequence);
			const admission = current;
			const assertCurrent = () => {
				if (
					admitted.get(providerId) !== admission ||
					JSON.stringify(readManagedProvider(options.modelsJsonPath, providerId)) !== binding
				)
					throw unavailable();
			};
			assertCurrent();
			options.authStorage.setRuntimeApiKey(providerId, credential.apiKey);
			return {
				assertCurrent,
				assertCredential: (key) => {
					assertCurrent();
					if (key !== credential.apiKey) throw unavailable();
				},
			};
		})()
			.catch((error: unknown) => {
				// A failed broker lookup never falls back to an earlier admission. An older failure
				// cannot revoke a newer successful admission from a concurrent request.
				if (managedProviders.has(providerId) && (admitted.get(providerId)?.sequence ?? 0) <= requestSequence)
					revoke(providerId, requestSequence);
				throw error;
			})
			.finally(() => {
				if (pending.get(signature) === promise) pending.delete(signature);
			});
		pending.set(signature, promise);
		return promise;
	};
	return {
		validateModelAccess: (model) =>
			validate(model.provider, {
				modelId: model.id,
				modelSourceId: model.modelId,
				baseUrl: model.baseUrl,
				...(model.headers ? { headers: { ...model.headers } } : {}),
			}),
		validateProviderAccess: (providerId) => validate(providerId),
	};
}
