import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const RELEASE_BUILD_JOBS = [
	"validate and test Desktop release",
	"build linux",
	"build windows",
	"build macos-arm64",
	"build macos-x64",
];

export function releaseBuildState(run, expectedSha, expectedAttempt) {
	if (run?.headSha !== expectedSha)
		return { state: "failure", reason: "build commit differs from this workflow commit" };
	if (run.workflowName !== "desktop-release") return { state: "failure", reason: "run is not desktop-release" };
	if (run.event !== "workflow_dispatch") return { state: "failure", reason: "run is not a workflow dispatch" };
	if (!Number.isSafeInteger(run.attempt) || run.attempt < 1)
		return { state: "failure", reason: "invalid run attempt" };
	if (expectedAttempt !== undefined && run.attempt !== expectedAttempt)
		return { state: "failure", reason: "run was restarted during release" };
	if (!Array.isArray(run.jobs)) return { state: "failure", reason: "run has no job list" };
	const jobs = RELEASE_BUILD_JOBS.map((name) => run.jobs.find((job) => job.name === name));
	const failed = jobs.find((job) => job?.status === "completed" && job.conclusion !== "success");
	if (failed) return { state: "failure", reason: `${failed.name}: ${failed.conclusion}` };
	if (jobs.every((job) => job?.status === "completed" && job.conclusion === "success"))
		return { state: "success", attempt: run.attempt };
	if (run.status === "completed") return { state: "failure", reason: "run ended without all required build gates" };
	return { state: "pending" };
}

function readRun(repo, runId) {
	return JSON.parse(
		execFileSync(
			"gh",
			["run", "view", runId, "--repo", repo, "--json", "headSha,workflowName,event,attempt,status,jobs"],
			{ encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
		),
	);
}

export async function waitForReleaseBuilds({
	repo,
	runId,
	expectedSha,
	expectedAttempt,
	read = readRun,
	delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	now = Date.now,
	timeoutMs = 330 * 60_000,
	pollMs = 60_000,
}) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(runId) || !/^[a-f\d]{40}$/.test(expectedSha)) {
		throw new Error("Expected a repository, numeric run ID and full commit SHA");
	}
	const deadline = now() + timeoutMs;
	let observedAttempt = expectedAttempt;
	while (now() < deadline) {
		const run = await read(repo, runId);
		const result = releaseBuildState(run, expectedSha, observedAttempt);
		if (result.state === "success") return result;
		if (result.state === "failure") throw new Error(`Release build ${runId} refused: ${result.reason}`);
		observedAttempt ??= run.attempt;
		await delay(Math.min(pollMs, Math.max(0, deadline - now())));
	}
	throw new Error(`Timed out waiting for release build ${runId}; no artifacts were published`);
}

async function main() {
	const { values } = parseArgs({
		options: {
			repo: { type: "string" },
			run: { type: "string" },
			sha: { type: "string" },
			attempt: { type: "string" },
			check: { type: "boolean", default: false },
		},
	});
	console.info(`Waiting for required build gates in run ${values.run}`);
	const expectedAttempt = values.attempt === undefined ? undefined : Number(values.attempt);
	let result;
	if (values.check) {
		if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1)
			throw new Error("A positive run attempt is required for --check");
		result = releaseBuildState(readRun(values.repo, values.run), values.sha, expectedAttempt);
		if (result.state !== "success")
			throw new Error(`Release build ${values.run} refused: ${result.reason ?? result.state}`);
	} else {
		result = await waitForReleaseBuilds({
			repo: values.repo,
			runId: values.run,
			expectedSha: values.sha,
			expectedAttempt,
		});
	}
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build_attempt=${result.attempt}\n`);
	console.info(`Required build gates passed for run ${values.run}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
