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
	const snapshotVersion = useRef(0);
	const mounted = useRef(false);
	const initialAutoLoginEligible = useRef(false);

	const checkStatus = useCallback(async () => {
		const version = snapshotVersion.current;
		try {
			const current = await window.vetta?.flowstoken?.getSnapshot();
			if (!mounted.current || version !== snapshotVersion.current) return;
			if (current) {
				initialAutoLoginEligible.current = !current.loggedIn;
				if (current.loggedIn) autoLoginAttempted = true;
				setSnapshot(current);
			}
		} catch (err) {
			if (!mounted.current || version !== snapshotVersion.current) return;
			console.error("[FlowstokenAuthGate] checkStatus error:", err);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (mounted.current && version === snapshotVersion.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void checkStatus();

		const cleanup = window.vetta?.flowstoken?.onAccountChanged?.((nextSnapshot) => {
			snapshotVersion.current += 1;
			initialAutoLoginEligible.current = false;
			if (nextSnapshot.loggedIn) autoLoginAttempted = true;
			setSnapshot(nextSnapshot);
			setError(nextSnapshot.lastError ?? null);
			setStatusText(null);
			setBusy(false);
			setLoading(false);
		});

		return () => {
			mounted.current = false;
			snapshotVersion.current += 1;
			if (typeof cleanup === "function") cleanup();
		};
	}, [checkStatus]);

	const handleBrowserLogin = async () => {
		const version = snapshotVersion.current;
		autoLoginAttempted = true;
		initialAutoLoginEligible.current = false;
		setBusy(true);
		setError(null);
		setStatusText(t("flowstokenAuth.statusOpening"));
		try {
			const res = await window.vetta.flowstoken.loginWithBrowser();
			if (!mounted.current || version !== snapshotVersion.current) return;
			if (res.ok && res.snapshot?.loggedIn) {
				const currentSnap = res.snapshot;
				setStatusText(t("flowstokenAuth.statusDone"));
				showToast({
					variant: currentSnap.lastError ? "info" : "success",
					title: t("flowstokenAuth.successTitle"),
					message: currentSnap.lastError ?? t("flowstokenAuth.successMessage"),
					durationMs: 5000,
				});
				setSnapshot(currentSnap);
			} else {
				const msg = res.error || t("flowstokenAuth.loginCancelled");
				setError(msg.includes("已关闭") ? t("flowstokenAuth.loginWindowClosed") : msg);
				setStatusText(null);
			}
		} catch (err) {
			if (!mounted.current || version !== snapshotVersion.current) return;
			setError(err instanceof Error ? err.message : String(err));
			setStatusText(null);
		} finally {
			if (mounted.current) setBusy(false);
		}
	};
	handleBrowserLoginRef.current = handleBrowserLogin;

	// Only the initial confirmed signed-out state may auto-open; account events include deliberate logout.
	useEffect(() => {
		if (loading || !initialAutoLoginEligible.current || !snapshot || snapshot.loggedIn || autoLoginAttempted) return;
		autoLoginAttempted = true;
		void handleBrowserLoginRef.current();
	}, [loading, snapshot]);

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
					{busy ? (
						<Button variant="ghost" className="w-full" onClick={() => void window.vetta.flowstoken.cancelLogin().catch((err: unknown) => {
							if (mounted.current) setError(err instanceof Error ? err.message : String(err));
						})}>
							{t("flowstokenAuth.cancelAuthorization")}
						</Button>
					) : null}
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
