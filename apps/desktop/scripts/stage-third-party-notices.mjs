import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const THIRD_PARTY_NOTICE_FILES = Object.freeze(["LICENSE", "NOTICE"]);

export function stageThirdPartyNotices({ repositoryRoot, destinationDir }) {
	// Validate both originals before producing a partially staged notices directory.
	const originals = THIRD_PARTY_NOTICE_FILES.map((name) => {
		let content;
		try {
			content = readFileSync(join(repositoryRoot, name));
		} catch (error) {
			throw new Error(`[prepare-pack] required attribution file is unavailable: ${name}`, { cause: error });
		}
		if (!content.length) throw new Error(`[prepare-pack] required attribution file is empty: ${name}`);
		return { name, content };
	});
	mkdirSync(destinationDir, { recursive: true });
	for (const { name, content } of originals) writeFileSync(join(destinationDir, name), content);
}
