import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_RPC_ENDPOINT_FILE_ENV } from "@vetta/action-rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCliCodingAgentBootstrap } from "../src/coding-agent-bootstrap.js";

let root = "";
let responseKey = "fixture-first-key";
let responseAccountId = 8;
let rejected = false;
let requestStarted: (() => void) | undefined;
let responseGate: Promise<void> | undefined;
const requests: Array<Record<string, unknown>> = [];
const provider = () => ({
	baseUrl: "https://www.flowstoken.com/v1",
	api: "openai-completions",
	credentialRef: "untouched-legacy-ref",
	managedGroup: { source: "flowstoken", accountId: 8, groupId: "default", tokenId: 10 },
	models: [{ id: "gpt-fixture", name: "Fixture", input: ["text"] }],
});

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "cli-managed-model-access-"));
	await Promise.all([mkdir(join(root, "agent")), mkdir(join(root, "workspace"))]);
	responseKey = "fixture-first-key";
	responseAccountId = 8;
	rejected = false;
	requestStarted = undefined;
	responseGate = undefined;
	requests.length = 0;
	await writeFile(
		join(root, "agent", "models.json"),
		JSON.stringify({ providers: { "flowstoken-default": provider() } }),
	);
	const endpointPath = join(root, "endpoint.json");
	await writeFile(
		endpointPath,
		JSON.stringify({ transport: "http", url: "http://127.0.0.1:32109", token: "fixture-ipc-token" }),
	);
	vi.stubEnv(ACTION_RPC_ENDPOINT_FILE_ENV, endpointPath);
	vi.stubEnv("VETTA_HOME", root);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: URL, init: RequestInit) => {
			expect(String(url)).toBe("http://127.0.0.1:32109/rpc");
			expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-ipc-token");
			const request = JSON.parse(String(init.body));
			requests.push(request);
			requestStarted?.();
			await responseGate;
			return Response.json(
				rejected
					? {
							id: request.id,
							ok: false,
							error: { code: "FLOWSTOKEN_AUTH_REQUIRED", message: "Login required" },
						}
					: {
							id: request.id,
							ok: true,
							result: {
								apiKey: responseKey,
								accountId: responseAccountId,
								groupId: "default",
								tokenId: 10,
								authRevision: 4,
							},
						},
			);
		}),
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

function bootstrap() {
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
	return createCliCodingAgentBootstrap({
		args: ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"],
		cwd: join(root, "workspace"),
		agentDir: join(root, "agent"),
	});
}

it("reacquires a managed key for every model lookup and refuses reuse after desktop logout", async () => {
	const host = await bootstrap();
	const model = host.modelRegistry.find("flowstoken-default", "gpt-fixture")!;
	expect(await host.modelRegistry.getApiKey(model)).toBe("fixture-first-key");
	responseKey = "fixture-rotated-key";
	expect(await host.modelRegistry.getApiKey(model)).toBe("fixture-rotated-key");
	rejected = true;
	await expect(host.modelRegistry.getApiKey(model)).rejects.toMatchObject({ code: "FLOWSTOKEN_AUTH_REQUIRED" });
	expect(await host.authStorage.getApiKey("flowstoken-default")).toBeUndefined();
	expect(requests).toHaveLength(3);
	const config = await readFile(join(root, "agent", "models.json"), "utf8");
	expect(config).not.toContain("fixture-first-key");
	expect(config).not.toContain("fixture-rotated-key");
	const auth = await readFile(join(root, "agent", "auth.json"), "utf8").catch(() => "");
	expect(auth).not.toContain("fixture-first-key");
	expect(auth).not.toContain("fixture-rotated-key");
});

it("checks provider-only credential lookups through the same desktop authority", async () => {
	const host = await bootstrap();
	expect(await host.modelRegistry.getApiKeyForProvider("flowstoken-default")).toBe("fixture-first-key");
	expect(requests[0]).toMatchObject({
		method: "models.resolveCredential",
		params: {
			providerId: "flowstoken-default",
			accountId: 8,
			groupId: "default",
			tokenId: 10,
			baseUrl: "https://www.flowstoken.com/v1",
		},
	});
});

it("rejects a credential response for another account without injecting it", async () => {
	const host = await bootstrap();
	responseAccountId = 9;
	await expect(
		host.modelRegistry.getApiKey(host.modelRegistry.find("flowstoken-default", "gpt-fixture")!),
	).rejects.toMatchObject({ code: "INVALID_CREDENTIAL_RESPONSE" });
	expect(await host.authStorage.getApiKey("flowstoken-default")).toBeUndefined();
});

it("rejects a late reply after the local account binding changes", async () => {
	const host = await bootstrap();
	const started = new Promise<void>((resolve) => {
		requestStarted = resolve;
	});
	let finish!: () => void;
	responseGate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const pending = host.modelRegistry
		.getApiKey(host.modelRegistry.find("flowstoken-default", "gpt-fixture")!)
		.catch((error: unknown) => error);
	await started;
	const changed = provider();
	changed.managedGroup.accountId = 9;
	await writeFile(
		join(root, "agent", "models.json"),
		JSON.stringify({ providers: { "flowstoken-default": changed } }),
	);
	finish();
	expect(await pending).toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	expect(await host.authStorage.getApiKey("flowstoken-default")).toBeUndefined();
});

it("includes the actual cached model route and headers in its authorization request", async () => {
	const host = await bootstrap();
	const model = {
		...host.modelRegistry.find("flowstoken-default", "gpt-fixture")!,
		baseUrl: "https://fixture.invalid/v1",
		headers: { "X-Fixture": "value" },
	};
	await host.modelRegistry.getApiKey(model);
	expect(requests[0]).toMatchObject({
		params: {
			modelId: "gpt-fixture",
			baseUrl: "https://fixture.invalid/v1",
			headers: { "X-Fixture": "value" },
		},
	});
});

it("leaves ordinary custom provider credentials on their existing path without requesting desktop access", async () => {
	await writeFile(
		join(root, "agent", "models.json"),
		JSON.stringify({
			providers: {
				personal: {
					baseUrl: "https://fixture.invalid/v1",
					api: "openai-completions",
					apiKey: "fixture-custom-key",
					models: [{ id: "fixture-model", input: ["text"] }],
				},
			},
		}),
	);
	const host = await bootstrap();
	expect(await host.modelRegistry.getApiKey(host.modelRegistry.find("personal", "fixture-model")!)).toBe(
		"fixture-custom-key",
	);
	expect(requests).toEqual([]);
});

it("allows two different models on the same provider to resolve concurrently", async () => {
	const shared = provider();
	shared.models.push({ id: "gpt-second", name: "Second", input: ["text"] });
	await writeFile(join(root, "agent", "models.json"), JSON.stringify({ providers: { "flowstoken-default": shared } }));
	const host = await bootstrap();
	const started = new Promise<void>((resolve) => {
		requestStarted = () => {
			if (requests.length === 2) resolve();
		};
	});
	let finish!: () => void;
	responseGate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const results = Promise.all([
		host.modelRegistry.getApiKey(host.modelRegistry.find("flowstoken-default", "gpt-fixture")!),
		host.modelRegistry.getApiKey(host.modelRegistry.find("flowstoken-default", "gpt-second")!),
	]);
	await started;
	finish();
	expect(await results).toEqual(["fixture-first-key", "fixture-first-key"]);
	expect(requests).toHaveLength(2);
});

it("does not bypass an official billing identity through a manual override in the same process", async () => {
	const host = await bootstrap();
	expect(await host.modelRegistry.getApiKey(host.modelRegistry.find("flowstoken-default", "gpt-fixture")!)).toBe(
		"fixture-first-key",
	);
	const custom = { ...provider(), managedGroupOverride: true, apiKey: "fixture-explicit-custom-key" };
	await writeFile(join(root, "agent", "models.json"), JSON.stringify({ providers: { "flowstoken-default": custom } }));
	host.modelRegistry.refresh();
	const model = host.modelRegistry.find("flowstoken-default", "gpt-fixture")!;
	await expect(host.modelRegistry.getApiKey(model)).rejects.toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	await expect(host.modelRegistry.getApiKey(model)).rejects.toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	expect(requests).toHaveLength(1);
});

it.each([
	"flowstoken-default",
	"flowstoken-normal",
	"flowstoken-smart",
	"flowstoken-official",
	"flowstoken-group-Research-X",
])("refuses an official provider without a binding after restart: %s", async (providerId) => {
	const { managedGroup: _binding, ...entry } = provider();
	await writeFile(
		join(root, "agent", "models.json"),
		JSON.stringify({
			providers: {
				[providerId]: { ...entry, apiKey: "fixture-unbound-key" },
			},
		}),
	);
	const host = await bootstrap();
	await expect(
		host.modelRegistry.getApiKey(host.modelRegistry.find(providerId, "gpt-fixture")!),
	).rejects.toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	expect(requests).toEqual([]);
});

it("keeps standalone personal BYOK providers usable even if their names resemble invalid official aliases", async () => {
	const ids = ["personal", "flowstoken-vip", "flowstoken-group-default", "flowstoken-group-../escape"];
	const { managedGroup: _binding, ...entry } = provider();
	await writeFile(
		join(root, "agent", "models.json"),
		JSON.stringify({
			providers: Object.fromEntries(
				ids.map((id) => [
					id,
					{
						...entry,
						apiKey: "fixture-personal-key",
						managedGroupOverride: true,
					},
				]),
			),
		}),
	);
	const host = await bootstrap();
	for (const id of ids)
		expect(await host.modelRegistry.getApiKey(host.modelRegistry.find(id, "gpt-fixture")!)).toBe(
			"fixture-personal-key",
		);
	expect(requests).toEqual([]);
});

it("refuses a cached managed model whose binding was removed before its first credential lookup", async () => {
	const host = await bootstrap();
	const model = host.modelRegistry.find("flowstoken-default", "gpt-fixture")!;
	await writeFile(join(root, "agent", "models.json"), JSON.stringify({ providers: {} }));
	await expect(host.modelRegistry.getApiKey(model)).rejects.toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	await expect(host.modelRegistry.getApiKey(model)).rejects.toMatchObject({ code: "FLOWSTOKEN_CREDENTIAL_STALE" });
	expect(requests).toEqual([]);
});
