import {
	invalidateFlowstokenCatalog,
	isFlowstokenCatalogRefreshing,
	notifyFlowstokenModelsChanged,
	revalidateFlowstokenCatalog,
} from "@shared/store/flowstoken-catalog";
import { modelCatalog } from "@shared/store/model-catalog";
import { useEffect } from "react";

/**
 * 应用级模型目录保鲜：挂载时、窗口重新获得焦点时、窗口从后台切回可见时，
 * 按 TTL 重新校验本地 models.json 与远程 provider catalog。
 *
 * 服务端增删模型后用户不必重启应用——切回窗口或打开模型菜单即可看到最新列表。
 * TTL 与失败冷却在 modelCatalog 内部判定，这里只负责接线，不做节流。
 */
export function useModelCatalogSync(): void {
	useEffect(() => {
		const revalidate = (): void => {
			void modelCatalog.revalidate().then(() => revalidateFlowstokenCatalog());
		};
		const onVisibilityChange = (): void => {
			if (document.visibilityState === "visible") revalidate();
		};
		revalidate();
		// Keep an always-open app current even without a focus or picker-open event.
		const timer = window.setInterval(revalidate, 60 * 1000);
		const disposeModelChanged = window.vetta.models.onChanged?.(() => {
			notifyFlowstokenModelsChanged();
			modelCatalog.invalidate("local");
			// Main's reconciliation emits this event before its paired reply. Starting
			// another local read here would continually invalidate that same reply.
			if (isFlowstokenCatalogRefreshing()) return;
			invalidateFlowstokenCatalog();
			void modelCatalog.revalidate({ force: true, sources: ["local"] }).then(() => revalidateFlowstokenCatalog());
		});
		const disposeAccountChanged = window.vetta.flowstoken?.onAccountChanged?.(() => {
			modelCatalog.invalidate("local");
			invalidateFlowstokenCatalog();
			void revalidateFlowstokenCatalog();
		});
		window.addEventListener("focus", revalidate);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", revalidate);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			disposeModelChanged?.();
			disposeAccountChanged?.();
		};
	}, []);
}
