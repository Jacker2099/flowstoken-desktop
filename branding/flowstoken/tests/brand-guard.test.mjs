// FlowsToken brand guard: fails when an upstream merge silently drops a FlowsToken customization.
// Run: node --test branding/flowstoken/tests/  (the upstream-sync and release workflows run it before shipping)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateDesktopBuildEnvironment } from "../../../apps/desktop/scripts/desktop-build-environment.mjs";
import { resolveDesktopReleaseConfig, toGithubEnv } from "../../../scripts/release/resolve-desktop-release-config.mjs";
import { FLOWSTOKEN_UPDATE_URL, isFlowsTokenUpdateFeed } from "../update-feed.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

function openSourceReleaseEnv() {
	const config = resolveDesktopReleaseConfig({ eventName: "workflow_dispatch", inputs: { release_target: "github" } });
	return Object.fromEntries(
		toGithubEnv(config)
			.split("\n")
			.filter(Boolean)
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

test("open-source CI builds are branded FlowsToken with the marketplace off", () => {
	const env = openSourceReleaseEnv();
	assert.equal(env.VETTA_PRODUCT_NAME, "FlowsToken");
	assert.equal(env.VETTA_EXECUTABLE_NAME, "FlowsToken");
	assert.equal(env.VETTA_APP_ID, "com.flowstoken.desktop");
	assert.equal(env.VETTA_PROTOCOL_SCHEME, "flowstoken");
	assert.equal(env.VETTA_DISABLE_BUILTIN_MARKETPLACE, "1");
	assert.equal(env.VETTA_CLOUD_ENABLED, "false");
});

test("open-source CI builds update from the FlowsToken server, not GitHub", () => {
	const env = openSourceReleaseEnv();
	assert.equal(env.VETTA_UPDATE_PROVIDER, "generic");
	assert.equal(env.VETTA_UPDATE_URL, FLOWSTOKEN_UPDATE_URL);
	const config = validateDesktopBuildEnvironment({
		env: { ...env, VETTA_VENDOR_PLATFORM: "linux-x64" },
		platform: "linux",
		arch: "x64",
	});
	assert.equal(config.edition, "opensource");
	assert.equal(config.updateConfig.provider, "generic");
	assert.equal(config.updateConfig.url, FLOWSTOKEN_UPDATE_URL);
});

test("only the FlowsToken https feed relaxes the open-source update rule", () => {
	assert.equal(isFlowsTokenUpdateFeed({ provider: "generic", url: FLOWSTOKEN_UPDATE_URL }), true);
	assert.equal(isFlowsTokenUpdateFeed({ provider: "generic", url: "http://www.flowstoken.com/downloads/desktop" }), false);
	assert.equal(isFlowsTokenUpdateFeed({ provider: "generic", url: "https://releases.openvetta.com/desktop/stable" }), false);
	assert.equal(isFlowsTokenUpdateFeed({ provider: "github", owner: "a", repo: "b" }), false);
	assert.throws(
		() =>
			validateDesktopBuildEnvironment({
				env: {
					VETTA_CLOUD_ENABLED: "false",
					VETTA_UPDATE_PROVIDER: "generic",
					VETTA_UPDATE_URL: "https://releases.openvetta.com/desktop/stable",
					VETTA_VENDOR_PLATFORM: "linux-x64",
				},
				platform: "linux",
				arch: "x64",
			}),
		/open-source builds must use/,
	);
});

test("FlowsToken account login, key sync and settings are present and wired", () => {
	for (const file of [
		"apps/desktop/src/main/flowstoken/account-service.ts",
		"apps/desktop/src/main/flowstoken/login-window.ts",
		"apps/desktop/src/main/flowstoken/newapi-client.ts",
		"apps/desktop/src/preload/apis/flowstoken.ts",
		"apps/desktop/src/renderer/domains/auth/FlowstokenAuthGate.tsx",
		"apps/desktop/src/renderer/domains/settings/components/FlowstokenAccountSettings.tsx",
	]) {
		assert.ok(existsSync(resolve(root, file)), `missing ${file}`);
	}
	assert.match(read("apps/desktop/src/renderer/App.tsx"), /<FlowstokenAuthGate>/);
	assert.match(read("apps/desktop/src/main/ipc/index.ts"), /registerFlowstokenAccountIpc\(\)/);
	assert.match(read("apps/desktop/src/renderer/domains/settings/registry.ts"), /"tabFlowstoken"/);
});

test("the four FlowsToken group presets point at flowstoken.com and are registered", () => {
	const presets = read("apps/desktop/src/main/models/presets/flowstoken-presets.ts");
	assert.match(presets, /https:\/\/www\.flowstoken\.com\/v1/);
	for (const id of ["flowstoken-default", "flowstoken-normal", "flowstoken-smart", "flowstoken-official"]) {
		assert.match(presets, new RegExp(`id: "${id}"`), `missing preset ${id}`);
	}
	assert.match(read("apps/desktop/src/main/models/presets/catalog.ts"), /FLOWSTOKEN_PRESET_PROVIDERS/);
});

test("the assistant identifies as Bestoo AI", () => {
	assert.match(read("packages/coding-agent/src/model-context/system-prompt-policy.ts"), /Your name is Bestoo AI/);
});

test("disabling the builtin marketplace never falls back to the Vetta marketplace", () => {
	assert.match(
		read("apps/desktop/src/main/abilities/open-marketplace/marketplace-source-store.ts"),
		/process\.env\.VETTA_DISABLE_BUILTIN_MARKETPLACE === "1"/,
	);
});
