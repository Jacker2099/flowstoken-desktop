import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Witness from "./testing-windows-witness.cjs";

export const windowsWitnessModulePath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../src/testing-windows-witness.cjs",
);

export function openOwnedWindowsProcessWitness(pid: number): Witness.NativeWindowsProcessWitness {
	const module = createRequire(import.meta.url)(windowsWitnessModulePath) as typeof Witness;
	return module.openNativeWindowsProcessWitness(pid);
}
