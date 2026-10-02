import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Jobs from "./testing-windows-job.cjs";

export function createOwnedWindowsTestJob(): Jobs.NativeWindowsTestJob {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "../src/testing-windows-job.cjs");
	return (createRequire(import.meta.url)(path) as typeof Jobs).createNativeWindowsTestJob();
}

export function createOwnedJobFromNativeCallsForTests(api: unknown): Jobs.NativeWindowsTestJob {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "../src/testing-windows-job.cjs");
	return (createRequire(import.meta.url)(path) as typeof Jobs).createWindowsTestJobWithApi(api);
}
