import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeArchiveTarCommand } from "../runtimes/runtime-archive-installer.js";

export async function extractSkillTarGz(archivePath: string, destination: string): Promise<void> {
	const stagingDirectory = await mkdtemp(join(dirname(archivePath), ".skill-tgz-"));
	try {
		// A truncated archive must not overwrite an installed skill before extraction succeeds.
		execFileSync(runtimeArchiveTarCommand(), ["-xzf", archivePath, "-C", stagingDirectory], { timeout: 30000 });
		await cp(stagingDirectory, destination, {
			recursive: true,
			verbatimSymlinks: true,
			preserveTimestamps: true,
		});
	} finally {
		await rm(stagingDirectory, { recursive: true, force: true });
	}
}
