import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Desktop shares React through Module Federation. Bun can install a separate
// React peer for the host UI's CJS dependencies; mirror that singleton in tests.
const pluginRequire = createRequire(import.meta.url);
const uiRequire = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../ui/package.json"));
const sharedReact: unknown = pluginRequire("react");
uiRequire("react");
const hostReact = uiRequire.cache[uiRequire.resolve("react")];
if (hostReact) hostReact.exports = sharedReact;

// jsdom 在 vitest 环境下不向 globalThis 暴露 localStorage（opaque origin），
// 插件运行时与测试都依赖 Web Storage，这里补一个进程内实现。
if (typeof globalThis.localStorage === "undefined") {
	const store = new Map<string, string>();
	const memoryStorage: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key) => store.get(key) ?? null,
		key: (index) => [...store.keys()][index] ?? null,
		removeItem: (key) => {
			store.delete(key);
		},
		setItem: (key, value) => {
			store.set(key, String(value));
		},
	};
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
}
