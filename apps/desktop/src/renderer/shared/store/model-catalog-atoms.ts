import type { FlowstokenCatalog, ModelsConfigData } from "@preload/api";
import { atom } from "jotai";

/**
 * 模型目录的两份共享状态。
 *
 * 单独成模块（只依赖 jotai）是为了让不需要 IPC/浏览器环境的模块也能引用它们，
 * 不被 auth-atoms 那条带副作用的依赖链拖进来。写入方统一是 model-catalog。
 */

type Update<T> = T | ((previous: T) => T);

function versionedAtom<T>(initial: T) {
	const valueAtom = atom(initial);
	const versionAtom = atom(0);
	const stateAtom = atom(
		(get) => get(valueAtom),
		(get, set, update: Update<T>) => {
			set(valueAtom, typeof update === "function" ? (update as (previous: T) => T)(get(valueAtom)) : update);
			set(versionAtom, get(versionAtom) + 1);
		},
	);
	return { stateAtom, versionAtom };
}

const local = versionedAtom<ModelsConfigData | null>(null);
const remote = versionedAtom<Record<string, unknown>>({});
const flowstoken = versionedAtom<FlowstokenCatalog | null>(null);

/** Every write, including a settings/BYOK edit, invalidates older async reads. */
export const localModelsConfigAtom = local.stateAtom;
export const localModelsConfigVersionAtom = local.versionAtom;

/** 服务端下发的远程 provider catalog（Vetta Go 等）。 */
export const remoteProvidersAtom = remote.stateAtom;
export const remoteProvidersVersionAtom = remote.versionAtom;

/** 服务端下发的 FlowsToken 模型目录（schema 1/2），null 表示尚未加载。 */
export const flowstokenCatalogAtom = flowstoken.stateAtom;
export const flowstokenCatalogVersionAtom = flowstoken.versionAtom;

/** Notify consumers only after both halves of the main-process snapshot are installed. */
export const applyFlowstokenCatalogSnapshotAtom = atom(
	null,
	(_get, set, snapshot: { catalog: FlowstokenCatalog; config: ModelsConfigData }) => {
		set(localModelsConfigAtom, snapshot.config);
		set(flowstokenCatalogAtom, snapshot.catalog);
	},
);
