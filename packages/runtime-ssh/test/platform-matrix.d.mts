import type { execFileSync } from "node:child_process";
import type { existsSync } from "node:fs";

export const PORTABLE_RUNTIME_SSH_SUITES: readonly string[];
export const POSIX_RUNTIME_SSH_SUITES: readonly string[];
export function discoverRuntimeSshSuites(root?: string): string[];
export function selectRuntimeSshSuites(platform?: NodeJS.Platform, files?: readonly string[]): string[];
export function requireNativeRuntimeSshTools(
	platform?: NodeJS.Platform,
	ports?: { run?: typeof execFileSync; exists?: typeof existsSync },
): void;
