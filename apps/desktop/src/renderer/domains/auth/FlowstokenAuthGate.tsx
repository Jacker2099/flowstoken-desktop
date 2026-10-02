import { Button } from "@shared/components/ui/button";
import { showToast } from "@shared/store/toast-atoms";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FlowstokenAccountSnapshot } from "../../../preload/api-types/flowstoken.js";

interface FlowstokenAuthGateProps {
	children: ReactNode;
}

/** 每次应用运行只自动拉起一次浏览器登录；用户关掉窗口后不再自动弹（可手动重试）。 */
let autoLoginAttempted = false;

export function FlowstokenAuthGate({ children }: FlowstokenAuthGateProps): JSX.Element {
	const { t } = useTranslation("common");
	const [snapshot, setSnapshot] = useState<FlowstokenAccountSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [statusText, setStatusText] = useState<string | null>(null);
	const handleBrowserLoginRef = useRef<() => Promise<void>>(async () => {});

	const checkStatus = useCallback(async () => {
		try {
			const current = await window.vetta?.flowstoken?.getSnapshot();
			if (current) {
				setSnapshot(current);
			}
		} catch (err) {
			console.error("[FlowstokenAuthGate] checkStatus error:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void checkStatus();

		const cleanup = window.vetta?.flowstoken?.onAccountChanged?.((nextSnapshot) => {
			setSnapshot(nextSnapshot);
			setLoading(false);
		});

		return () => {
			if (typeof cleanup === "function") cleanup();
		};
	}, [checkStatus]);

	const handleBrowserLogin = async () => {
		setBusy(true);
		setError(null);
		setStatusText(t("flowstokenAuth.statusOpening"));
		try {
			const res = await window.vetta.flowstoken.loginWithBrowser();
			if (res.ok && res.snapshot?.loggedIn) {
				let currentSnap = res.snapshot;
				// 如果有任何分组尚未接入，自动进行二次保障同步，无需人工点击
				if (currentSnap.groups?.some((g) => g.enabled && !g.wired)) {
					setStatusText(t("flowstokenAuth.statusSyncing"));
					try {
						const ensureRes = await window.vetta.flowstoken.ensureKeys();
						if (ensureRes.snapshot) {
							currentSnap = ensureRes.snapshot;
						}
					} catch (e) {
						console.warn("[FlowstokenAuthGate] Secondary key ensure failed:", e);
					}
				}
				setStatusText(t("flowstokenAuth.statusDone"));
				showToast({
					variant: "success",
					title: t("flowstokenAuth.successTitle"),
					message: t("flowstokenAuth.successMessage"),
					durationMs: 5000,
				});
				setSnapshot(currentSnap);
			} else {
				const msg = res.error || t("flowstokenAuth.loginCancelled");
				setError(msg.includes("已关闭") ? t("flowstokenAuth.loginWindowClosed") : msg);
				setStatusText(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatusText(null);
		} finally {
			setBusy(false);
		}
	};
	handleBrowserLoginRef.current = handleBrowserLogin;

	// 拿到快照且未登录时自动拉起一次官方登录窗口；无论成败都不再自动重试。
	useEffect(() => {
		if (loading || snapshot?.loggedIn || autoLoginAttempted) return;
		autoLoginAttempted = true;
		void handleBrowserLoginRef.current();
	}, [loading, snapshot?.loggedIn]);

	if (loading) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-background text-foreground select-none">
				<div className="flex flex-col items-center gap-3">
					<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
					<p className="text-[13px] text-muted-foreground">{t("flowstokenAuth.loading")}</p>
				</div>
			</div>
		);
	}

	if (snapshot?.loggedIn && snapshot.user) {
		return <>{children}</>;
	}

	return (
		<div className="fixed inset-0 z-[99999] flex h-screen w-screen items-center justify-center bg-background/95 backdrop-blur-md px-4 select-none">
			<div className="w-full max-w-[400px] rounded-2xl border border-border/80 bg-card/90 p-8 shadow-2xl backdrop-blur-xl space-y-6">
				{/* 品牌与标题 */}
				<div className="flex flex-col items-center text-center space-y-2.5">
					<img
						src="./flowstoken-logo.png"
						alt="FlowsToken"
						className="h-16 w-16 rounded-2xl shadow-lg border border-border/50 object-cover"
						onError={(e) => {
							(e.currentTarget as HTMLImageElement).src = "./icon.png";
						}}
					/>
					<h1 className="text-[22px] font-bold tracking-tight text-foreground">
						{t("flowstokenAuth.welcome")}
					</h1>
					<p className="text-[13px] text-muted-foreground leading-relaxed px-2">
						{t("flowstokenAuth.subtitle")}
					</p>
				</div>

				{/* 错误提示 */}
				{error ? (
					<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-[12px] text-destructive text-center leading-normal">
						{error}
					</div>
				) : null}

				{/* 状态提示 */}
				{statusText ? (
					<div className="rounded-lg border border-primary/30 bg-primary/10 px-3.5 py-2.5 text-[12px] text-primary text-center leading-normal animate-pulse">
						{statusText}
					</div>
				) : null}

				{/* 登录主体 */}
				<div className="space-y-3.5 pt-1">
					<Button
						className="w-full h-11 text-[14px] font-semibold shadow-sm transition-all hover:scale-[1.01]"
						disabled={busy}
						onClick={() => void handleBrowserLogin()}
					>
						{busy ? t("flowstokenAuth.loggingIn") : t("flowstokenAuth.loginButton")}
					</Button>
					<p className="text-[11px] text-muted-foreground text-center leading-relaxed">
						{t("flowstokenAuth.footerHint")}
					</p>
				</div>

				{/* 底部导航链接 */}
				<div className="pt-3 border-t border-border/60 flex items-center justify-between text-[12px] text-muted-foreground px-2">
					<button
						type="button"
						className="hover:text-foreground transition-colors cursor-pointer"
						onClick={() => void window.vetta.flowstoken.openExternal("https://www.flowstoken.com/register")}
					>
						{t("flowstokenAuth.register")}
					</button>
					<span className="text-border">·</span>
					<button
						type="button"
						className="hover:text-foreground transition-colors cursor-pointer"
						onClick={() => void window.vetta.flowstoken.openExternal("https://www.flowstoken.com")}
					>
						{t("flowstokenAuth.homepage")}
					</button>
					<span className="text-border">·</span>
					<button
						type="button"
						className="hover:text-foreground transition-colors cursor-pointer"
						onClick={() => void window.vetta.flowstoken.openExternal("https://www.flowstoken.com/contact")}
					>
						{t("flowstokenAuth.support")}
					</button>
				</div>
			</div>
		</div>
	);
}
