import { getDefaultStore } from "jotai";
import { flowstokenModelMetaAtom } from "./model-catalog-atoms";

const TTL_MS = 10 * 60 * 1000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/**
 * 从主进程取 FlowsToken 分组模型的厂商与 NEW 标记。TTL 内复用上次结果；
 * 取不到（未登录、离线、非 FlowsToken 构建）时保持原值，选择器照常平铺显示。
 */
export function revalidateFlowstokenModelMeta(now: number = Date.now()): Promise<void> {
	if (inflight) return inflight;
	if (loadedAt && now - loadedAt < TTL_MS) return Promise.resolve();
	const getModelMeta = window.vetta?.flowstoken?.getModelMeta;
	if (!getModelMeta) return Promise.resolve();
	inflight = getModelMeta()
		.then((meta) => {
			if (meta && Object.keys(meta).length > 0) {
				getDefaultStore().set(flowstokenModelMetaAtom, meta);
				loadedAt = Date.now();
			}
		})
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}
