import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { assertDraft, assertUploadedAssets, publishRelease } from "../../../scripts/flowstoken/publish-release.mjs";
import { checkpoint, digest, verifyReleaseArtifacts } from "../../../scripts/flowstoken/release-artifacts.mjs";

const identity = { version: "0.6.3", sha: "a".repeat(40), run: "123", attempt: 2 };
const repo = "Jacker2099/flowstoken-desktop";
const prefix = `FlowsToken-${identity.version}`;

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "flowstoken-integrity-"));
	const feeds = {
		"latest.yml": [`${prefix}-win-x64.exe`],
		"latest-linux.yml": ["AppImage", "deb", "rpm"].map((extension) => `${prefix}.${extension}`),
		"latest-mac.yml": [`${prefix}-mac.zip`, `${prefix}.dmg`, `${prefix}-arm64-mac.zip`, `${prefix}-arm64.dmg`],
	};
	for (const [feed, names] of Object.entries(feeds)) {
		const files = [];
		for (const name of names) {
			const body = Buffer.from(`signed fixture ${name}`);
			await writeFile(join(directory, name), body);
			files.push({ url: name, size: body.length, sha512: createHash("sha512").update(body).digest("base64") });
			if (/\.(zip|exe|dmg)$/.test(name)) await writeFile(join(directory, `${name}.blockmap`), "blockmap fixture");
		}
		await writeFile(
			join(directory, feed),
			JSON.stringify({ version: identity.version, files, path: files[0].url, sha512: files[0].sha512 }),
		);
	}
	await writeFile(join(directory, `${prefix}-win-x64.zip`), "supplemental ZIP fixture");
	return directory;
}

test("a complete three-platform release validates feed hashes and records every downloadable file", async () => {
	const directory = await fixture();
	try {
		const manifest = await verifyReleaseArtifacts(directory, identity);
		assert.equal(manifest.files.length, 17);
		assert.ok(manifest.files.every((file) => /^[a-f\d]{64}$/.test(file.sha256)));
		assert.equal(JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8")).sha, identity.sha);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing, corrupt, wrong-version and unexpected artifacts all block a release", async () => {
	for (const mutate of [
		(directory) => rm(join(directory, `${prefix}-win-x64.zip`)),
		(directory) => writeFile(join(directory, `${prefix}-win-x64.exe`), "corrupt"),
		(directory) => writeFile(join(directory, `${prefix}-mac.zip.blockmap`), ""),
		(directory) => writeFile(join(directory, "old-installer.exe"), "stale"),
		async (directory) => {
			const file = join(directory, "latest.yml");
			const feed = JSON.parse(await readFile(file, "utf8"));
			feed.version = "0.6.2";
			await writeFile(file, JSON.stringify(feed));
		},
	]) {
		const directory = await fixture();
		try {
			await mutate(directory);
			await assert.rejects(verifyReleaseArtifacts(directory, identity));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("checkpoint provenance binds bytes, version, source commit, run and platform while allowing retained successful jobs", async () => {
	const directory = await fixture();
	const source = { ...identity, attempt: 1, platform: "macos-arm64" };
	try {
		await writeFile(join(directory, `default._${prefix}.dmg`), "AppleDouble resource fork");
		await checkpoint(directory, source);
		const recorded = JSON.parse(await readFile(join(directory, "release-provenance.json"), "utf8"));
		assert.ok(recorded.files.every((file) => !file.name.startsWith("default._")));
		await checkpoint(directory, { ...source, attempt: 2 }, true);
		for (const changed of [
			{ sha: "b".repeat(40) },
			{ run: "456" },
			{ platform: "macos-x64" },
			{ version: "0.6.4" },
			{ attempt: 0 },
		]) {
			await assert.rejects(checkpoint(directory, { ...source, ...changed }, true));
		}
		await writeFile(join(directory, `${prefix}-win-x64.zip`), "tampered supplemental ZIP");
		await assert.rejects(checkpoint(directory, source, true), /hashes changed/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("published releases and unavailable GitHub APIs fail closed", async () => {
	await assert.rejects(
		assertDraft(repo, "v0.6.3", async () => ({ draft: false, tag_name: "v0.6.3" })),
		/Refusing/,
	);
	await assert.rejects(
		assertDraft(repo, "v0.6.3", async () => {
			throw new Error("GitHub 503");
		}),
		/503/,
	);
	assert.equal(await assertDraft(repo, "v0.6.3", async (path) => (path.includes("/tags/") ? null : [])), null);
});

test("drafts hidden from the tag endpoint are found by exact tag in the complete authenticated release list", async () => {
	const draft = { id: 42, draft: true, tag_name: "v0.6.3" };
	const older = Array.from({ length: 100 }, (_, index) => ({
		id: index + 100,
		draft: false,
		tag_name: `v0.5.${index}`,
	}));
	const calls = [];
	assert.deepEqual(
		await assertDraft(repo, draft.tag_name, async (path) => {
			calls.push(path);
			if (path.endsWith("/tags/v0.6.3")) return null;
			if (path.endsWith("?per_page=100&page=1")) return older;
			if (path.endsWith("?per_page=100&page=2")) return [draft];
			throw new Error(`Unexpected GitHub endpoint: ${path}`);
		}),
		draft,
	);
	assert.equal(calls.length, 3);
	assert.deepEqual(await assertDraft(repo, draft.tag_name, async () => draft), draft);
	await assert.rejects(
		assertDraft(repo, draft.tag_name, async () => ({ ...draft, tag_name: "v0.6.2" })),
		/Refusing/,
	);
});

test("draft list fallback rejects published releases, duplicate tags, malformed pages and incomplete bounded scans", async () => {
	const draft = { id: 42, draft: true, tag_name: "v0.6.3" };
	const unrelated = Array.from({ length: 99 }, (_, index) => ({
		id: index + 100,
		draft: false,
		tag_name: `v0.5.${index}`,
	}));
	for (const [pages, error] of [
		[[[{ ...draft, draft: false }]], /Refusing/],
		[[[draft, { ...draft, id: 43 }]], /Ambiguous/],
		[[[draft, ...unrelated], [draft]], /Ambiguous/],
		[[null], /release list/],
		[[[null]], /release list/],
		[[[{ ...draft, id: undefined }]], /release list/],
		[[Array(101).fill(draft)], /release list/],
		[Array.from({ length: 10 }, () => [{ ...draft, tag_name: "unrelated" }, ...unrelated]), /limit/],
	]) {
		let page = 0;
		await assert.rejects(
			assertDraft(repo, draft.tag_name, async (path) => (path.includes("/tags/") ? null : pages[page++])),
			error,
		);
		assert.ok(page <= 10);
	}
	await assert.rejects(
		assertDraft(repo, draft.tag_name, async (path) => {
			if (path.includes("/tags/")) return null;
			throw new Error("GitHub list 503");
		}),
		/503/,
	);
});

test("a retry finds the hidden draft, cleans stale assets, verifies uploaded digests and only then publishes", async () => {
	const directory = await fixture();
	try {
		await verifyReleaseArtifacts(directory, identity);
		const draft = { id: 42, draft: true, tag_name: "v0.6.3" };
		let assets = [{ name: "old-build.dmg" }];
		const actions = [];
		const run = async (...args) => {
			actions.push(args);
			if (args[1] === "delete-asset") assets = assets.filter((asset) => asset.name !== args[3]);
			if (args[1] === "upload")
				assets = await Promise.all(
					args.slice(3, args.indexOf("--repo")).map(async (path) => ({
						name: basename(path),
						size: (await readFile(path)).length,
						digest: `sha256:${await digest(path)}`,
						state: "uploaded",
					})),
				);
			if (args.includes("--draft=false")) draft.draft = false;
		};
		const expected = await publishRelease({
			repo,
			...identity,
			directory,
			notes: "/tmp/notes",
			api: async (path) => {
				if (path.includes("/assets?")) return assets;
				if (path.includes("/tags/")) return null;
				assert.equal(path, `repos/${repo}/releases?per_page=100&page=1`);
				return [draft];
			},
			run,
			checkTag: () => {},
		});
		assert.equal(draft.draft, false);
		assert.equal(actions[0][1], "delete-asset");
		assert.ok(actions.at(-1).includes("--draft=false"));
		assertUploadedAssets(assets, expected);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("bad uploaded hashes or a moving tag leave the release in draft", async () => {
	for (const failure of ["hash", "tag"]) {
		const directory = await fixture();
		try {
			await verifyReleaseArtifacts(directory, identity);
			const draft = { id: 42, draft: true, tag_name: "v0.6.3" };
			let assets = [];
			let uploaded = false;
			const actions = [];
			const run = async (...args) => {
				actions.push(args);
				if (args[1] === "upload") {
					uploaded = true;
					assets = args
						.slice(3, args.indexOf("--repo"))
						.map((path) => ({ name: basename(path), size: 1, digest: "sha256:bad", state: "uploaded" }));
				}
			};
			await assert.rejects(
				publishRelease({
					repo,
					...identity,
					directory,
					notes: "/tmp/notes",
					api: async (path) => (path.includes("/assets?") ? assets : draft),
					run,
					checkTag: () => {
						if (failure === "tag" && uploaded) throw new Error("Tag changed");
					},
				}),
			);
			assert.equal(draft.draft, true);
			assert.ok(actions.every((args) => !args.includes("--draft=false")));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});
