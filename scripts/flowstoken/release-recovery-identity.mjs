import { createHash } from "node:crypto";
import { assertReleaseSourceEligible } from "./release-source-policy.mjs";

export const RECOVERY_PLATFORMS = ["linux", "windows", "macos-arm64", "macos-x64"];
export const SOURCE_CONFIG_FILES = ["apps/desktop/package.json", "apps/desktop/scripts/prepare-pack.js", "bun.lock"];
export const VERIFICATION_HARNESS_INPUTS = [
	"apps/desktop/wdio.conf.ts",
	"apps/desktop/e2e",
	"apps/desktop/scripts/electron-e2e-service-options.mjs",
	"apps/desktop/scripts/packaged-e2e-binary.mjs",
];
const shaPattern = /^[a-f\d]{40}$/;
const digestPattern = /^sha256:[a-f\d]{64}$/;
const uuidPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function originalSubmissionFromLog(log, expected) {
	if (typeof log !== "string" || !uuidPattern.test(expected ?? ""))
		throw new Error("An explicit original submission UUID is required");
	const uuid = "([a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12})";
	const patterns = [
		new RegExp(`appstoreconnect\\.apple\\.com/notary/v2/submissions/${uuid}`, "gi"),
		new RegExp(`Submission\\s+${uuid}\\s+recorded\\b`, "gi"),
	];
	const found = new Set(
		patterns.flatMap((pattern) => [...log.matchAll(pattern)].map((match) => match[1].toLowerCase())),
	);
	if (found.size !== 1 || !found.has(expected.toLowerCase()))
		throw new Error("The original job log does not uniquely bind the requested notarization ID");
	return expected.toLowerCase();
}

export function recoveryPlanDigest(plan) {
	return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function validateRecoveryPlan(plan, expected = {}) {
	if (
		plan?.schema !== 1 ||
		!/^[\w.-]+\/[\w.-]+$/.test(plan.repo) ||
		!shaPattern.test(plan.controllerSha) ||
		!/^\d+$/.test(plan.recoveryRun)
	)
		throw new Error("Invalid recovery controller identity");
	const source = plan.source;
	if (
		!source ||
		!shaPattern.test(source.sha) ||
		!/^\d+$/.test(source.run) ||
		!Number.isSafeInteger(source.attempt) ||
		source.attempt < 1 ||
		!/^\d+\.\d+\.\d+$/.test(source.version)
	)
		throw new Error("Invalid original source identity");
	assertReleaseSourceEligible(source.sha);
	if (source.run === plan.recoveryRun) throw new Error("Recovery must use a different run from its original source");
	for (const [key, value] of Object.entries(expected)) {
		const actual = key.startsWith("source.") ? source[key.slice(7)] : plan[key];
		if (actual !== value) throw new Error(`Recovery identity mismatch: ${key}`);
	}
	for (const name of SOURCE_CONFIG_FILES)
		if (!/^[a-f\d]{64}$/.test(source.configHashes?.[name]))
			throw new Error(`Missing source configuration hash: ${name}`);
	if (JSON.stringify(Object.keys(plan.platforms ?? {}).sort()) !== JSON.stringify([...RECOVERY_PLATFORMS].sort()))
		throw new Error("Recovery must include exactly four platforms");
	const ids = new Set();
	for (const platform of RECOVERY_PLATFORMS) {
		const entry = plan.platforms[platform];
		const artifact = entry?.artifact;
		if (
			!Number.isSafeInteger(entry?.jobId) ||
			entry.jobId < 1 ||
			!Number.isSafeInteger(artifact?.id) ||
			artifact.id < 1 ||
			!digestPattern.test(artifact.digest) ||
			!Number.isSafeInteger(artifact.size) ||
			artifact.size < 1 ||
			ids.has(artifact.id)
		)
			throw new Error(`Invalid original artifact: ${platform}`);
		ids.add(artifact.id);
		if (entry.mode === "checkpoint") {
			if (artifact.name !== `release-build-${platform}` || entry.submissionId !== undefined)
				throw new Error(`Invalid retained checkpoint: ${platform}`);
		} else if (entry.mode === "signed-app") {
			if (
				!platform.startsWith("macos-") ||
				artifact.name !== `failed-macos-${platform}` ||
				!uuidPattern.test(entry.submissionId)
			)
				throw new Error(`Invalid original notarization binding: ${platform}`);
		} else throw new Error(`Unsupported recovery mode: ${platform}`);
	}
	return plan;
}

export function buildRecoveryPlan({
	repo,
	controllerSha,
	recoveryRun,
	sourceSha,
	sourceAttempt,
	version,
	configHashes,
	sourceRun,
	jobs,
	artifacts,
	submissions = {},
	submissionIdsByJob = {},
}) {
	if (
		sourceRun?.head_sha !== sourceSha ||
		sourceRun.run_attempt !== sourceAttempt ||
		sourceRun.status !== "completed" ||
		sourceRun.event !== "workflow_dispatch" ||
		sourceRun.path !== ".github/workflows/desktop-release.yml"
	)
		throw new Error("Original run must be a completed desktop-release dispatch at the exact source SHA and attempt");
	const platforms = {};
	for (const platform of RECOVERY_PLATFORMS) {
		const matchedJobs = jobs.filter((job) => job.name === `build ${platform}`);
		if (matchedJobs.length !== 1 || matchedJobs[0].status !== "completed")
			throw new Error(`Original platform job is not complete: ${platform}`);
		const job = matchedJobs[0];
		const mode = job.conclusion === "success" ? "checkpoint" : "signed-app";
		if (mode === "signed-app" && (!platform.startsWith("macos-") || job.conclusion !== "failure"))
			throw new Error(`No validated reusable original platform: ${platform}`);
		const name = mode === "checkpoint" ? `release-build-${platform}` : `failed-macos-${platform}`;
		const matches = artifacts.filter((artifact) => artifact.name === name);
		if (matches.length !== 1) throw new Error(`Expected exactly one original artifact: ${name}`);
		const artifact = matches[0];
		if (
			artifact.expired ||
			String(artifact.workflow_run?.id) !== String(sourceRun.id) ||
			artifact.workflow_run?.head_sha !== sourceSha
		)
			throw new Error(`Original artifact source mismatch: ${name}`);
		if (mode === "signed-app" && submissionIdsByJob[job.id] !== submissions[platform]?.toLowerCase())
			throw new Error(`Original submission is not bound to its source job log: ${platform}`);
		platforms[platform] = {
			mode,
			jobId: job.id,
			artifact: { id: artifact.id, name, digest: artifact.digest, size: artifact.size_in_bytes },
			...(mode === "signed-app" ? { submissionId: submissions[platform] } : {}),
		};
	}
	return validateRecoveryPlan({
		schema: 1,
		repo,
		controllerSha,
		recoveryRun,
		source: { run: String(sourceRun.id), attempt: sourceAttempt, sha: sourceSha, version, configHashes },
		platforms,
	});
}

export async function verifyRecoveryPlanOnline(plan, api) {
	validateRecoveryPlan(plan);
	const source = await api(`repos/${plan.repo}/actions/runs/${plan.source.run}`);
	if (
		source.head_sha !== plan.source.sha ||
		source.run_attempt !== plan.source.attempt ||
		source.status !== "completed" ||
		source.event !== "workflow_dispatch" ||
		source.path !== ".github/workflows/desktop-release.yml"
	)
		throw new Error("Original run changed since recovery planning");
	for (const platform of RECOVERY_PLATFORMS) {
		const expected = plan.platforms[platform].artifact;
		const current = await api(`repos/${plan.repo}/actions/artifacts/${expected.id}`);
		if (
			current.expired ||
			current.name !== expected.name ||
			current.digest !== expected.digest ||
			current.size_in_bytes !== expected.size ||
			String(current.workflow_run?.id) !== plan.source.run ||
			current.workflow_run?.head_sha !== plan.source.sha
		)
			throw new Error(`Original artifact changed: ${platform}`);
	}
}

export function assertRecoveryCheckpoint(saved, expected, plan) {
	if ((saved.controllerSha ?? saved.sha) !== (expected.controllerSha ?? expected.sha))
		throw new Error("Checkpoint controller SHA differs from requested release");
	if (plan || saved.recovery) {
		validateRecoveryPlan(plan, {
			controllerSha: expected.controllerSha,
			recoveryRun: expected.run,
			"source.sha": expected.sha,
			"source.version": expected.version,
		});
		if (
			saved.recovery?.planDigest !== recoveryPlanDigest(plan) ||
			JSON.stringify(saved.recovery?.origin) !== JSON.stringify(plan.platforms[expected.platform])
		)
			throw new Error("Checkpoint recovery lineage differs from the approved plan");
	} else if (saved.sha !== (saved.controllerSha ?? saved.sha))
		throw new Error("Cross-SHA checkpoints require explicit recovery lineage");
}

export function validateManifestLineage(identity) {
	assertReleaseSourceEligible(identity.sha);
	const controllerSha = identity.controllerSha ?? identity.sha;
	if (!identity.recoveryPlan) {
		if (identity.sha !== controllerSha || identity.lineage?.some((entry) => entry.recovery))
			throw new Error("Recovered releases require an explicit recovery plan");
		return;
	}
	const plan = validateRecoveryPlan(identity.recoveryPlan, {
		controllerSha,
		recoveryRun: identity.run,
		"source.sha": identity.sha,
		"source.version": identity.version,
	});
	if (
		!Array.isArray(identity.lineage) ||
		JSON.stringify(identity.lineage.map((entry) => entry.platform).sort()) !==
			JSON.stringify([...RECOVERY_PLATFORMS].sort())
	)
		throw new Error("Recovery manifest is missing a platform's verified lineage");
	for (const saved of identity.lineage) {
		for (const key of ["sha", "run", "version"])
			if (saved[key] !== identity[key]) throw new Error(`Recovery platform ${key} differs from the release`);
		if (!Number.isSafeInteger(saved.attempt) || saved.attempt < 1 || saved.attempt > identity.attempt)
			throw new Error("Recovery checkpoint attempt is invalid");
		assertRecoveryCheckpoint(saved, { ...identity, platform: saved.platform }, plan);
		if (saved.recovery.origin.mode === "signed-app") {
			const receipt = saved.recovery.notarization;
			if (
				receipt?.schema !== 1 ||
				receipt.phase !== "stapled" ||
				receipt.submissionId !== saved.recovery.origin.submissionId ||
				receipt.acceptance?.submissionId !== receipt.submissionId ||
				receipt.identity?.bundleId !== "com.flowstoken.desktop" ||
				receipt.identity?.version !== identity.version
			)
				throw new Error("Recovery manifest lacks the original accepted and stapled Mac receipt");
			const arch = saved.platform.slice("macos-".length);
			const signatureArch = arch === "x64" ? "x86_64" : arch;
			if (
				JSON.stringify(receipt.identity.architectures) !== JSON.stringify([signatureArch]) ||
				!/^[a-f\d]{40}$/.test(receipt.identity.signatureHashes?.[signatureArch]) ||
				receipt.acceptance.signatureHashes?.[signatureArch] !== receipt.identity.signatureHashes[signatureArch]
			)
				throw new Error("Recovery receipt architecture or accepted CDHash differs from the app");
			const packaging = saved.recovery.packaging;
			if (
				packaging?.schema !== 1 ||
				packaging.sourceSha !== identity.sha ||
				packaging.version !== identity.version ||
				packaging.appId !== receipt.identity.bundleId ||
				packaging.arch !== arch ||
				packaging.cdhash !== receipt.identity.signatureHashes?.[signatureArch] ||
				packaging.teamId !== receipt.identity.teamId
			)
				throw new Error("Recovery packaging proof differs from the original app and Apple acceptance");
		}
	}
}
