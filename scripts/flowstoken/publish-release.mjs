import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { digest, verifyReleaseArtifacts } from "./release-artifacts.mjs";
import { validateManifestLineage, verifyRecoveryPlanOnline } from "./release-recovery-identity.mjs";
import { assertReleaseSourceEligible } from "./release-source-policy.mjs";

export async function githubJson(path, { allowMissing = false } = {}) {
	const response = await fetch(`https://api.github.com/${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${process.env.GH_TOKEN}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: AbortSignal.timeout(60_000),
	});
	if (response.status === 404 && allowMissing) return null;
	if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${path}`);
	return response.json();
}

export async function assertDraft(repo, tag, api = githubJson) {
	const release = await api(`repos/${repo}/releases/tags/${tag}`, { allowMissing: true });
	if (release && (release.draft !== true || release.tag_name !== tag))
		throw new Error(`Refusing published or mismatched release ${tag}`);
	return release;
}

export function assertUploadedAssets(assets, expected) {
	if (!Array.isArray(assets) || assets.length !== expected.length)
		throw new Error("Uploaded asset set is incomplete or contains extra files");
	for (const file of expected) {
		const matches = assets.filter((asset) => asset.name === file.name);
		if (
			matches.length !== 1 ||
			matches[0].state !== "uploaded" ||
			matches[0].size !== file.size ||
			matches[0].digest !== `sha256:${file.sha256}`
		) {
			throw new Error(`Uploaded asset size/hash mismatch: ${file.name}`);
		}
	}
}

function command(...args) {
	return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
}

export function assertTag(tag, sha) {
	const output = execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
		encoding: "utf8",
	}).trim();
	const entries = output
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(/\s+/));
	const current = entries.find((entry) => entry[1].endsWith("^{}")) ?? entries[0];
	if (current?.[0] !== sha) throw new Error(`Release tag ${tag} does not point to ${sha}`);
}

export async function publishRelease({
	repo,
	version,
	sha,
	controllerSha = sha,
	directory,
	notes,
	api = githubJson,
	run = command,
	checkTag = assertTag,
}) {
	assertReleaseSourceEligible(sha);
	const tag = `v${version}`;
	const saved = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"));
	if (saved.version !== version || saved.sha !== sha || (saved.controllerSha ?? saved.sha) !== controllerSha)
		throw new Error("Release manifest does not match this workflow");
	validateManifestLineage(saved);
	if (saved.recoveryPlan) await verifyRecoveryPlanOnline(saved.recoveryPlan, api);
	const current = await verifyReleaseArtifacts(directory, saved);
	if (JSON.stringify(saved.files) !== JSON.stringify(current.files))
		throw new Error("Release files changed after verification");
	const expected = [
		...current.files,
		{
			name: "release-manifest.json",
			size: (await stat(join(directory, "release-manifest.json"))).size,
			sha256: await digest(join(directory, "release-manifest.json")),
		},
	];
	await checkTag(tag, sha);
	let release = await assertDraft(repo, tag, api);
	if (!release) {
		await run(
			"release",
			"create",
			tag,
			"--repo",
			repo,
			"--draft",
			"--verify-tag",
			"--target",
			sha,
			"--title",
			`FlowsToken Desktop ${version}`,
			"--notes-file",
			notes,
		);
		release = await assertDraft(repo, tag, api);
		if (!release) throw new Error("Created draft is not readable");
	}
	const releaseId = release.id;
	const ensureDraft = async () => {
		await checkTag(tag, sha);
		const latest = await assertDraft(repo, tag, api);
		if (latest?.id !== releaseId) throw new Error("Release was replaced during upload");
	};
	const assetPath = `repos/${repo}/releases/${releaseId}/assets?per_page=100`;
	const existing = await api(assetPath);
	if (!Array.isArray(existing) || existing.length >= 100) throw new Error("Unexpected draft asset list");
	for (const asset of existing) {
		if (!expected.some((file) => file.name === asset.name)) {
			await ensureDraft();
			await run("release", "delete-asset", tag, asset.name, "--repo", repo, "--yes");
		}
	}
	await ensureDraft();
	await run("release", "edit", tag, "--repo", repo, "--title", `FlowsToken Desktop ${version}`, "--notes-file", notes);
	await run(
		"release",
		"upload",
		tag,
		...expected.map((file) => join(directory, file.name)),
		"--repo",
		repo,
		"--clobber",
	);
	await ensureDraft();
	assertUploadedAssets(await api(assetPath), expected);
	await ensureDraft();
	await run("release", "edit", tag, "--repo", repo, "--draft=false", "--latest");
	return expected;
}

async function main() {
	const { values } = parseArgs({
		options: {
			repo: { type: "string" },
			version: { type: "string" },
			sha: { type: "string" },
			"controller-sha": { type: "string" },
			dir: { type: "string" },
			notes: { type: "string" },
			check: { type: "boolean", default: false },
		},
	});
	if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo) || !/^\d+\.\d+\.\d+$/.test(values.version))
		throw new Error("Invalid release identity");
	if (values.check) {
		const release = await assertDraft(values.repo, `v${values.version}`);
		console.info(release ? "draft" : "absent");
	} else {
		if (!/^[a-f\d]{40}$/.test(values.sha)) throw new Error("A full commit SHA is required");
		await publishRelease({
			repo: values.repo,
			version: values.version,
			sha: values.sha,
			controllerSha: values["controller-sha"] ?? values.sha,
			directory: resolve(values.dir),
			notes: values.notes,
		});
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
