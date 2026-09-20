import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { FlowstokenAccountSnapshot } from "../../../preload/api-types/flowstoken.js";

interface FlowstokenAuthGateProps {
	children: ReactNode;
}

export function FlowstokenAuthGate({ children }: FlowstokenAuthGateProps): JSX.Element {
	const [snapshot, setSnapshot] = useState<FlowstokenAccountSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [statusText, setStatusText] = useState<string | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");

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
		setStatusText("已拉起官方安全登录窗口，请在弹窗中完成登录...");
		try {
			const res = await window.vetta.flowstoken.loginWithBrowser();
			if (res.ok && res.snapshot?.loggedIn) {
				setStatusText("登录成功！正在同步「普通/智能/官方」通道密钥...");
				setSnapshot(res.snapshot);
			} else {
				setError(res.error || "登录未完成或已取消");
				setStatusText(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatusText(null);
		} finally {
			setBusy(false);
		}
	};

	const handlePasswordLogin = async () => {
		if (!username || !password) return;
		setBusy(true);
		setError(null);
		setStatusText("正在进行安全验证并登录...");
		try {
			const res = await window.vetta.flowstoken.loginWithPassword(username, password);
			if (res.ok && res.snapshot?.loggedIn) {
				setStatusText("登录成功！正在同步「普通/智能/官方」通道密钥...");
				setPassword("");
				setSnapshot(res.snapshot);
			} else {
				setError(res.error || "登录失败，请检查账号密码");
				setStatusText(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatusText(null);
		} finally {
			setBusy(false);
		}
	};

	if (loading) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-background text-foreground select-none">
				<div className="flex flex-col items-center gap-3">
					<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
					<p className="text-[13px] text-muted-foreground">正在载入 FlowsToken 账户状态...</p>
				</div>
			</div>
		);
	}

	if (snapshot?.loggedIn && snapshot.user) {
		return <>{children}</>;
	}

	return (
		<div className="fixed inset-0 z-[99999] flex h-screen w-screen items-center justify-center bg-background/95 backdrop-blur-md px-4 select-none">
			<div className="w-full max-w-[420px] rounded-2xl border border-border/80 bg-card/90 p-8 shadow-2xl backdrop-blur-xl space-y-6">
				{/* 品牌与标题 */}
				<div className="flex flex-col items-center text-center space-y-2">
					<img
						src="./flowstoken-logo.png"
						alt="FlowsToken"
						className="h-16 w-16 rounded-2xl shadow-lg border border-border/50 object-cover"
						onError={(e) => {
							// 兜底回退
							(e.currentTarget as HTMLImageElement).src = "./icon.png";
						}}
					/>
					<h1 className="text-[22px] font-bold tracking-tight text-foreground">欢迎使用 FlowsToken</h1>
					<p className="text-[13px] text-muted-foreground leading-relaxed px-2">
						集成大模型与 AI 智能编程客户端。请先登录您的 FlowsToken 账户以启用全部模型通道。
					</p>
				</div>

				{/* 错误提示 */}
				{error ? (
					<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive text-center leading-normal">
						{error}
					</div>
				) : null}

				{/* 状态提示 */}
				{statusText ? (
					<div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[12px] text-primary text-center leading-normal animate-pulse">
						{statusText}
					</div>
				) : null}

				{/* 登录主体 */}
				<div className="space-y-4">
					{/* 推荐登录按钮 */}
					<Button
						className="w-full h-11 text-[14px] font-medium shadow-sm transition-all hover:scale-[1.01]"
						disabled={busy}
						onClick={() => void handleBrowserLogin()}
					>
						{busy && !username ? "正在登录..." : "一键登录 FlowsToken 账户 (推荐)"}
					</Button>
					<p className="text-[11px] text-muted-foreground text-center">
						支持账号密码、验证码、GitHub、Linux.do 及原生安全验证
					</p>

					{/* 分割线 */}
					<div className="relative flex py-1 items-center">
						<div className="flex-grow border-t border-border" />
						<span className="flex-shrink mx-3 text-[11px] text-muted-foreground uppercase">
							或直接输入账号密码
						</span>
						<div className="flex-grow border-t border-border" />
					</div>

					{/* 账号密码表单 */}
					<div className="space-y-2.5">
						<Input
							placeholder="用户名 / 注册邮箱"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							disabled={busy}
							autoComplete="username"
							className="h-10 text-[13px]"
						/>
						<Input
							type="password"
							placeholder="密码"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							disabled={busy}
							autoComplete="current-password"
							className="h-10 text-[13px]"
							onKeyDown={(e) => {
								if (e.key === "Enter" && username && password && !busy) {
									void handlePasswordLogin();
								}
							}}
						/>
						<Button
							variant="secondary"
							className="w-full h-10 text-[13px]"
							disabled={busy || !username || !password}
							onClick={() => void handlePasswordLogin()}
						>
							{busy && username ? "验证并登录中..." : "账号密码直接登录"}
						</Button>
					</div>
				</div>

				{/* 底部导航链接 */}
				<div className="pt-2 border-t border-border/60 flex items-center justify-between text-[12px] text-muted-foreground px-1">
					<button
						type="button"
						className="hover:text-foreground transition-colors cursor-pointer"
						onClick={() => void window.vetta.flowstoken.openExternal("https://www.flowstoken.com/register")}
					>
						注册新账号
					</button>
					<span className="text-border">·</span>
					<button
						type="button"
						className="hover:text-foreground transition-colors cursor-pointer"
						onClick={() => void window.vetta.flowstoken.openExternal("https://www.flowstoken.com")}
					>
						官方主页
					</button>
					<span className="text-border">·</span>
					<button
						type="button"
						className="hover:text-foreground transition-colors cursor-pointer"
						onClick={() => void window.vetta.flowstoken.openExternal("https://www.flowstoken.com/contact")}
					>
						帮助与客服
					</button>
				</div>
			</div>
		</div>
	);
}
