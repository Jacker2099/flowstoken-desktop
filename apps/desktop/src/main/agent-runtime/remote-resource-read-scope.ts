import { AsyncLocalStorage } from "node:async_hooks";
import type { NodeResourceAccess, NodeResourceAccessOptions } from "@vetta/runtime-node/host";
import { isSshProjectUri } from "@vetta/ssh-transport";

interface ReadScope {
	active: boolean;
	readonly reads: Map<string, Promise<unknown>>;
}

/** One remote reload observes its actual reads once; later reloads and other callers always read afresh. */
export function createRemoteResourceReadScope(resourceAccess: NodeResourceAccess) {
	const storage = new AsyncLocalStorage<ReadScope>();
	let activeRuns = 0;
	function read<T>(
		operation: string,
		path: string,
		options: NodeResourceAccessOptions | undefined,
		load: () => Promise<T>,
	): Promise<T> {
		const scope = storage.getStore();
		// Cancellation keeps the underlying port's original signal and error semantics.
		if (!scope?.active || options?.signal || !isSshProjectUri(path)) return load();
		const key = `${operation}:${path}`;
		const existing = scope.reads.get(key);
		if (existing) return existing as Promise<T>;
		const pending = Promise.resolve().then(load);
		scope.reads.set(key, pending);
		void pending.catch(() => {
			if (scope.active && scope.reads.get(key) === pending) scope.reads.delete(key);
		});
		return pending;
	}
	return {
		access: {
			...resourceAccess,
			files: {
				...resourceAccess.files,
				readDirectory: (path: string, options?: NodeResourceAccessOptions) =>
					resourceAccess.files.readDirectory(path, options),
				stat: (path: string, options?: NodeResourceAccessOptions) =>
					read("stat", path, options, () => resourceAccess.files.stat(path, options)),
				readText: (path: string, options?: NodeResourceAccessOptions) =>
					read("readText", path, options, () => resourceAccess.files.readText(path, options)),
				realPath: (path: string, options?: NodeResourceAccessOptions) =>
					read("realPath", path, options, () => resourceAccess.files.realPath(path, options)),
			},
		} satisfies NodeResourceAccess,
		async run<T>(load: () => Promise<T>): Promise<T> {
			const scope: ReadScope = { active: true, reads: new Map() };
			activeRuns++;
			return storage.run(scope, async () => {
				try {
					return await load();
				} finally {
					scope.active = false;
					scope.reads.clear();
					// Disable only after all nested/concurrent reloads leave; the next run re-enables it.
					if (--activeRuns === 0) storage.disable();
				}
			});
		},
	};
}
