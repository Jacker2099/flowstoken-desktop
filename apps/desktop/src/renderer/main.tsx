import { AppBootLoadingView } from "@vetta-org/theme-ui/app-boot";
import { createRoot } from "react-dom/client";
import { preloadStartupPage } from "./root-layout/preload-startup-page";
import { waitForCommittedPaint } from "./shared/lib/committed-paint";
import { installInactiveWindowAnimationPause } from "./shared/lib/inactive-window-animations";
import { installLiveAnimations } from "./shared/lib/live-animations";
import { applyPlatformAttribute } from "./shared/lib/platform";
import { applyInitialTheme, syncInitialNativeTheme } from "./shared/theme/apply";
import { applyStoredCursorStyle } from "./shared/theme/cursor";
import { applyStoredSidebarStyle } from "./shared/theme/sidebar-style";
import { captureReactError, initializeRendererErrorMonitoring } from "./telemetry/error-monitoring";
import { initializeViteHmrDiagnostics } from "./telemetry/vite-hmr-diagnostics";
import "./styles.css";

initializeViteHmrDiagnostics();
initializeRendererErrorMonitoring("main");

// 在首个 React 节点挂载前同步恢复持久化主题与光标，保证窗口首次可见时已使用实际设计令牌。
applyPlatformAttribute();
applyInitialTheme();
const nativeThemeReady = syncInitialNativeTheme();
applyStoredCursorStyle();
applyStoredSidebarStyle();
// 窗口不在前台时停掉无限循环的动画：毛玻璃窗口每出一帧都很贵，没人看的时候不该为它付费。
installInactiveWindowAnimationPause();
// 「进行中」指示器的呼吸/波纹由这里统一挂 steps(16) 合成器动画并锁同一相位：整页每秒最多多出 10 帧。
installLiveAnimations();

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Missing root element");
}

const root = createRoot(rootElement, {
	onCaughtError: captureReactError,
	onRecoverableError: captureReactError,
});
const appReadyPromise = window.vetta.appLifecycle.whenReady();

root.render(<AppBootLoadingView />);

// 两帧后再通知主进程显示窗口，确保主题变量与 theme-ui 启动骨架已经完成绘制。
// 窗口被系统判为遮挡时 Chromium 会冻结 rAF（锁屏、其他 Space、守护进程拉起均会
// 触发），此时没有可见内容可等——waitForCommittedPaint 直接放行或限时兜底，
// 否则主进程等不到 painted 信号、启动永久停在骨架屏。
const bootPaintedPromise = waitForCommittedPaint({ timeoutMs: 10_000 })
	.then(() => nativeThemeReady)
	.then(() => {
		window.vetta.appLifecycle.reportRendererBootPainted();
	});
const renderAppPromise = import("./renderApp");
if (import.meta.env.DEV) void preloadStartupPage(window.location.hash);

void Promise.all([appReadyPromise, bootPaintedPromise, renderAppPromise])
	.then(([, , { renderApp }]) => {
		renderApp(root);
	})
	.catch((error: unknown) => {
		console.error("Failed to initialize renderer", error);
	});
