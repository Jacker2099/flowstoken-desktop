import { readFileSync } from "node:fs";

const policy = JSON.parse(
	readFileSync(new URL("../../branding/flowstoken/release-source-policy.json", import.meta.url), "utf8"),
);
if (policy.schema !== 1 || !policy.deniedSources || Array.isArray(policy.deniedSources))
	throw new Error("Invalid release source policy");
for (const [sha, reason] of Object.entries(policy.deniedSources))
	if (!/^[a-f\d]{40}$/.test(sha) || typeof reason !== "string" || !reason.trim())
		throw new Error("Invalid denied release source");

export function assertReleaseSourceEligible(sha) {
	if (!/^[a-f\d]{40}$/.test(sha ?? "")) throw new Error("A full application source SHA is required");
	if (Object.hasOwn(policy.deniedSources, sha))
		throw new Error(`Application source ${sha} is prohibited from release: ${policy.deniedSources[sha]}`);
}
