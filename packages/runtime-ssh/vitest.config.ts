import { defineConfig } from "vitest/config";
import { requireNativeRuntimeSshTools, selectRuntimeSshSuites } from "./test/platform-matrix.mjs";

const include = selectRuntimeSshSuites();
requireNativeRuntimeSshTools();

export default defineConfig({ test: { environment: "node", include, passWithNoTests: false } });
