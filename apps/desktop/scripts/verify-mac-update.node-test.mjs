import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { retryTransientNetwork, verifyMacUpdate } from "./verify-mac-update.mjs";

const temporaryRoots = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture({ includeBlockmap = true, sha512 = undefined } = {}) {
	const releaseDir = await mkdtemp(join(tmpdir(), "vetta-mac-update-test-"));
	temporaryRoots.push(releaseDir);
	const fileName = "Vetta-1.2.3-mac.zip";
	const content = Buffer.from("test update zip");
	const actualSha512 = createHash("sha512").update(content).digest("base64");
	await writeFile(join(releaseDir, fileName), content);
	if (includeBlockmap) await writeFile(join(releaseDir, `${fileName}.blockmap`), "blockmap");
	await writeFile(
		join(releaseDir, "latest-mac.yml"),
		stringify({
			version: "1.2.3",
			files: [{ url: fileName, sha512: sha512 ?? actualSha512, size: content.length }],
			path: fileName,
			sha512: sha512 ?? actualSha512,
		}),
	);
	return releaseDir;
}

test("verifies Mac update metadata, ZIP, hash, size, and blockmap", async () => {
	const releaseDir = await createFixture();
	const result = await verifyMacUpdate({ releaseDir, requireSignature: false });
	assert.equal(result.version, "1.2.3");
});

test("rejects a Mac update without a ZIP blockmap", async () => {
	const releaseDir = await createFixture({ includeBlockmap: false });
	await assert.rejects(
		verifyMacUpdate({ releaseDir, requireSignature: false }),
		/missing ZIP blockmap/,
	);
});

test("rejects a Mac update with a mismatched hash", async () => {
	const releaseDir = await createFixture({ sha512: "invalid" });
	await assert.rejects(
		verifyMacUpdate({ releaseDir, requireSignature: false }),
		/SHA-512 mismatch/,
	);
});

function setAppId(context, appId) {
	const previous = process.env.VETTA_APP_ID;
	context.after(() => {
		if (previous === undefined) delete process.env.VETTA_APP_ID;
		else process.env.VETTA_APP_ID = previous;
	});
	if (appId === undefined) delete process.env.VETTA_APP_ID;
	else process.env.VETTA_APP_ID = appId;
}

function createMacCommands({ bundleIdentifier = "com.flowstoken.desktop", failCommand } = {}) {
	const calls = [];
	const runCommand = async (command, args) => {
		calls.push([command, ...args]);
		if (command === failCommand) throw new Error(`${command} rejected update`);
		if (command === "ditto") {
			await mkdir(join(args[3], "FlowsToken.app", "Contents"), { recursive: true });
		} else if (command === "/usr/libexec/PlistBuddy") {
			const values = {
				"Print :CFBundleShortVersionString": "1.2.3",
				"Print :CFBundleIdentifier": bundleIdentifier,
			};
			assert.ok(Object.hasOwn(values, args[1]), `unexpected plist key: ${args[1]}`);
			return { stdout: `${values[args[1]]}\n` };
		} else {
			assert.ok(["codesign", "spctl", "xcrun"].includes(command), `unexpected command: ${command}`);
		}
		return { stdout: "" };
	};
	return { calls, runCommand };
}

for (const [appId, bundleIdentifier] of [
	[undefined, "com.flowstoken.desktop"],
	["", "com.flowstoken.desktop"],
	[" \n", "com.flowstoken.desktop"],
	["com.example.flowstoken-preview", "com.example.flowstoken-preview"],
	[" com.example.flowstoken-preview ", "com.example.flowstoken-preview"],
]) {
	test(`verifies the signed update with VETTA_APP_ID=${JSON.stringify(appId)}`, async (context) => {
		setAppId(context, appId);
		const releaseDir = await createFixture();
		const { calls, runCommand } = createMacCommands({ bundleIdentifier });
		const result = await verifyMacUpdate({ releaseDir, requireSignature: true, runCommand, platform: "darwin" });
		assert.equal(result.version, "1.2.3");
		const extractDir = calls[0][4];
		const appPath = join(extractDir, "FlowsToken.app");
		assert.deepEqual(calls.slice(-3), [
			["codesign", "--verify", "--deep", "--strict", "--verbose=2", appPath],
			["spctl", "-a", "-vvv", "-t", "exec", appPath],
			["xcrun", "stapler", "validate", appPath],
		]);
		await assert.rejects(stat(extractDir), { code: "ENOENT" });
	});
}

test("rejects the old Vetta identifier in a FlowsToken update", async (context) => {
	setAppId(context, undefined);
	const releaseDir = await createFixture();
	const { runCommand } = createMacCommands({ bundleIdentifier: "com.vetta.desktop" });
	await assert.rejects(
		verifyMacUpdate({ releaseDir, requireSignature: true, runCommand, platform: "darwin" }),
		/app identifier com\.vetta\.desktop does not match com\.flowstoken\.desktop/,
	);
});

test("rejects an update whose identifier differs from VETTA_APP_ID", async (context) => {
	setAppId(context, "com.example.flowstoken-preview");
	const releaseDir = await createFixture();
	const { runCommand } = createMacCommands();
	await assert.rejects(
		verifyMacUpdate({ releaseDir, requireSignature: true, runCommand, platform: "darwin" }),
		/app identifier com\.flowstoken\.desktop does not match com\.example\.flowstoken-preview/,
	);
});

test("rejects malformed VETTA_APP_ID instead of silently using the default", async (context) => {
	setAppId(context, undefined);
	const releaseDir = await createFixture();
	const { calls, runCommand } = createMacCommands();
	for (const appId of ["com..flowstoken", "com.flow stoken.desktop", "com/flowstoken"]) {
		process.env.VETTA_APP_ID = appId;
		await assert.rejects(
			verifyMacUpdate({ releaseDir, requireSignature: true, runCommand, platform: "darwin" }),
			/VETTA_APP_ID must be a reverse-DNS bundle identifier/,
		);
	}
	assert.deepEqual(calls, []);
});

for (const failCommand of ["codesign", "spctl", "xcrun"]) {
	test(`rejects the signed update when ${failCommand} verification fails`, async (context) => {
		setAppId(context, undefined);
		const releaseDir = await createFixture();
		const { calls, runCommand } = createMacCommands({ failCommand });
		await assert.rejects(verifyMacUpdate({ releaseDir, requireSignature: true, runCommand, platform: "darwin" }), new RegExp(`${failCommand} rejected update`));
		await assert.rejects(stat(calls[0][4]), { code: "ENOENT" });
	});
}

const networkError = () =>
	Object.assign(new Error("Command failed: xcrun stapler validate"), {
		stdout: 'NSURLErrorDomain Code=-1005 "The network connection was lost."\nError 68.',
	});

test("retries a transient CloudKit network failure until it succeeds", async () => {
	let calls = 0;
	const result = await retryTransientNetwork(
		async () => {
			calls += 1;
			if (calls < 3) throw networkError();
			return "ok";
		},
		{ sleep: async () => {} },
	);
	assert.equal(result, "ok");
	assert.equal(calls, 3);
});

test("gives up after the allowed attempts on a persistent network failure", async () => {
	let calls = 0;
	await assert.rejects(
		retryTransientNetwork(
			async () => {
				calls += 1;
				throw networkError();
			},
			{ attempts: 3, sleep: async () => {} },
		),
		/stapler validate/,
	);
	assert.equal(calls, 3);
});

test("does not retry a genuine validation failure", async () => {
	let calls = 0;
	await assert.rejects(
		retryTransientNetwork(
			async () => {
				calls += 1;
				throw Object.assign(new Error("rejected"), { stdout: "The validate action failed! Error 65." });
			},
			{ sleep: async () => {} },
		),
		/rejected/,
	);
	assert.equal(calls, 1);
});
