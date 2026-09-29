import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { githubJson } from "./publish-release.mjs";

export function planUpstreamRelease({ upstream, synced, published, activeRuns = [], sha }) {
	if (
		!upstream ||
		upstream.draft !== false ||
		upstream.prerelease !== false ||
		!/^v\d+\.\d+\.\d+$/.test(upstream.tag_name)
	) {
		throw new Error("Upstream sync requires a published stable semantic-version release");
	}
	if (upstream.tag_name !== synced) return "merge";
	if (published && published.draft === false) return "skip";
	if (activeRuns.some((run) => run.head_sha === sha && run.status !== "completed")) return "skip";
	return "release";
}

async function main() {
	const requested = process.env.INPUT_UPSTREAM_TAG?.trim();
	if (requested && !/^v\d+\.\d+\.\d+$/.test(requested)) throw new Error("Invalid upstream tag");
	const repo = process.env.GITHUB_REPOSITORY;
	const sha = process.env.CURRENT_SHA;
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f\d]{40}$/.test(sha))
		throw new Error("Missing sync repository or commit");
	const upstream = await githubJson(
		`repos/openvetta/open-vetta/releases/${requested ? `tags/${requested}` : "latest"}`,
	);
	const synced = readFileSync("branding/flowstoken/UPSTREAM_SYNCED", "utf8").trim();
	let published = null;
	let activeRuns = [];
	if (upstream.tag_name === synced) {
		const { version } = JSON.parse(readFileSync("apps/desktop/package.json", "utf8"));
		published = await githubJson(`repos/${repo}/releases/tags/v${version}`, { allowMissing: true });
		if (!published || published.draft) {
			const runs = await githubJson(
				`repos/${repo}/actions/workflows/flowstoken-release.yml/runs?per_page=100&head_sha=${sha}`,
			);
			if (!Array.isArray(runs.workflow_runs)) throw new Error("Cannot determine active release runs");
			activeRuns = runs.workflow_runs;
		}
	}
	const mode = planUpstreamRelease({ upstream, synced, published, activeRuns, sha });
	console.info(`Upstream ${upstream.tag_name}: ${mode}`);
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		`tag=${upstream.tag_name}\nsha=${sha}\nskip=${mode !== "merge"}\nresume_release=${mode === "release"}\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
