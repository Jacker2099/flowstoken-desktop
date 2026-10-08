import { ActionRpcError } from "./errors.js";
import type { ActionRpcRequest, DebugRpcRequest, LocalRpcRequest } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ActionRpcError("INVALID_REQUEST", "Request must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function requireId(record: Record<string, unknown>): string {
	if (typeof record.id !== "string" || record.id.length === 0) {
		throw new ActionRpcError("INVALID_REQUEST", "Request id is required");
	}
	return record.id;
}

function requireStringParam(params: Record<string, unknown> | undefined, name: string): string {
	const value = params?.[name];
	if (typeof value !== "string" || value.length === 0) {
		throw new ActionRpcError("INVALID_REQUEST", `params.${name} is required`);
	}
	return value;
}

export function parseLocalRpcRequest(value: unknown): LocalRpcRequest {
	const record = asRecord(value);
	const id = requireId(record);
	const method = record.method;
	if (
		method !== "actions.search" &&
		method !== "actions.describe" &&
		method !== "actions.run" &&
		method !== "debug.search" &&
		method !== "debug.describe" &&
		method !== "debug.run" &&
		method !== "models.resolveCredential"
	) {
		throw new ActionRpcError("INVALID_REQUEST", "Unsupported request method", {
			method: typeof method === "string" ? method : "unknown",
		});
	}

	const params = record.params === undefined ? undefined : asRecord(record.params);
	if (method === "models.resolveCredential") {
		const accountId = params?.accountId;
		const tokenId = params?.tokenId;
		if (
			typeof accountId !== "number" ||
			!Number.isSafeInteger(accountId) ||
			accountId <= 0 ||
			typeof tokenId !== "number" ||
			!Number.isSafeInteger(tokenId) ||
			tokenId <= 0
		) {
			throw new ActionRpcError("INVALID_REQUEST", "A valid account and token binding is required");
		}
		let headers: Record<string, string> | undefined;
		if (params?.headers !== undefined) {
			const raw = asRecord(params.headers);
			if (Object.values(raw).some((value) => typeof value !== "string")) {
				throw new ActionRpcError("INVALID_REQUEST", "Invalid model headers");
			}
			headers = raw as Record<string, string>;
		}
		return {
			id,
			method,
			params: {
				providerId: requireStringParam(params, "providerId"),
				groupId: requireStringParam(params, "groupId"),
				baseUrl: requireStringParam(params, "baseUrl"),
				accountId,
				tokenId,
				headers,
				...(params?.modelId === undefined ? {} : { modelId: requireStringParam(params, "modelId") }),
				...(params?.modelSourceId === undefined
					? {}
					: { modelSourceId: requireStringParam(params, "modelSourceId") }),
			},
		};
	}
	if (method === "actions.search") {
		return {
			id,
			method,
			params: {
				query: typeof params?.query === "string" ? params.query : undefined,
				domain: typeof params?.domain === "string" ? params.domain : undefined,
			},
		};
	}

	if (method === "debug.search") {
		return {
			id,
			method,
			params: {
				query: typeof params?.query === "string" ? params.query : undefined,
				category: typeof params?.category === "string" ? params.category : undefined,
			},
		};
	}

	if (method === "debug.describe") {
		return { id, method, params: { debugId: requireStringParam(params, "debugId") } };
	}
	if (method === "debug.run") {
		return {
			id,
			method,
			params: { debugId: requireStringParam(params, "debugId"), input: params?.input },
		};
	}

	const actionId = requireStringParam(params, "actionId");
	if (method === "actions.describe") {
		return {
			id,
			method,
			params: { actionId },
		};
	}

	return {
		id,
		method,
		params: {
			actionId,
			input: params?.input,
		},
	};
}

export function parseActionRpcRequest(value: unknown): ActionRpcRequest {
	const request = parseLocalRpcRequest(value);
	if (!request.method.startsWith("actions.")) {
		throw new ActionRpcError("INVALID_REQUEST", "Unsupported action request method", {
			method: request.method,
		});
	}
	return request as ActionRpcRequest;
}

export function parseDebugRpcRequest(value: unknown): DebugRpcRequest {
	const request = parseLocalRpcRequest(value);
	if (!request.method.startsWith("debug.")) {
		throw new ActionRpcError("INVALID_REQUEST", "Unsupported debug request method", {
			method: request.method,
		});
	}
	return request as DebugRpcRequest;
}
