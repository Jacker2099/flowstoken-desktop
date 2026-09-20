import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import type { FlowstokenAccountSettingsModel } from "./useFlowstokenAccountSettingsModel";

export function FlowstokenAccountSettingsView({
	model,
}: {
	model: FlowstokenAccountSettingsModel;
}): JSX.Element {
	const snapshot = model.snapshot;
	const loggedIn = Boolean(snapshot?.loggedIn && snapshot.user);

	return (
		<div className="mx-auto w-full max-w-[720px] space-y-6 px-8 pt-2 pb-10">
			<header className="space-y-1">
				<h1 className="text-[22px] font-bold text-foreground">FlowsToken 账户</h1>
				<p className="text-[13px] text-muted-foreground">
					登录一次即可自动创建/复用「普通组 / 智能组 / 官方组」密钥并写入系统凭据库，无需手动粘贴。官方组仅提供厂商
					GPT / Claude 等官方模型。
				</p>
			</header>

			{model.error ? (
				<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
					{model.error}
				</div>
			) : null}

			<section className="space-y-3 rounded-xl border border-border bg-card p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="text-[14px] font-medium">账户状态</div>
						<div className="text-[13px] text-muted-foreground">
							{loggedIn
								? `${snapshot?.user?.displayName || snapshot?.user?.username}（已登录）`
								: "未登录 — 登录后即可一键启用三组通道"}
						</div>
					</div>
					<div className="flex gap-2">
						<Button variant="outline" size="sm" disabled={model.busy} onClick={() => void model.refresh()}>
							刷新
						</Button>
						{loggedIn ? (
							<Button variant="ghost" size="sm" disabled={model.busy} onClick={() => void model.logout()}>
								退出登录
							</Button>
						) : null}
					</div>
				</div>

				{loggedIn ? (
					<div className="grid grid-cols-2 gap-3 text-[13px]">
						<div className="rounded-lg bg-muted/40 px-3 py-2">
							<div className="text-muted-foreground">余额</div>
							<div className="text-[18px] font-semibold">{snapshot?.balanceUsd}</div>
						</div>
						<div className="rounded-lg bg-muted/40 px-3 py-2">
							<div className="text-muted-foreground">已用额度</div>
							<div className="text-[18px] font-semibold">{snapshot?.usedUsd}</div>
						</div>
					</div>
				) : (
					<div className="space-y-3">
						<div className="grid gap-2">
							<Input
								placeholder="用户名 / 邮箱"
								value={model.username}
								onChange={(event) => model.setUsername(event.target.value)}
								disabled={model.busy}
								autoComplete="username"
							/>
							<Input
								type="password"
								placeholder="密码"
								value={model.password}
								onChange={(event) => model.setPassword(event.target.value)}
								disabled={model.busy}
								autoComplete="current-password"
							/>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button disabled={model.busy} onClick={() => void model.loginBrowser()}>
								一键登录 FlowsToken 账户 (推荐)
							</Button>
							<Button
								variant="outline"
								disabled={model.busy || !model.username || !model.password}
								onClick={() => void model.loginPassword()}
							>
								账号密码直接登录
							</Button>
						</div>
					</div>
				)}
			</section>

			{loggedIn ? (
				<section className="space-y-3 rounded-xl border border-border bg-card p-4">
					<div className="flex items-center justify-between">
						<div>
							<div className="text-[14px] font-medium">三组通道</div>
							<div className="text-[13px] text-muted-foreground">
								自动创建或复用桌面专用令牌，并写入模型服务商
							</div>
						</div>
						<Button size="sm" disabled={model.busy} onClick={() => void model.ensureKeys()}>
							重新同步密钥
						</Button>
					</div>
					<ul className="space-y-2">
						{(snapshot?.groups ?? []).map((group) => (
							<li
								key={group.groupId}
								className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-[13px]"
							>
								<div>
									<div className="font-medium">{group.labelZh}</div>
									<div className="text-muted-foreground">{group.tokenName}</div>
								</div>
								<span className={group.wired ? "text-emerald-600" : "text-amber-600"}>
									{group.wired ? "已接入" : "未接入"}
								</span>
							</li>
						))}
					</ul>
					<div className="flex flex-wrap gap-2 pt-1">
						<Button variant="outline" size="sm" onClick={() => void model.openTopup()}>
							前往充值
						</Button>
						<Button variant="outline" size="sm" onClick={() => void model.openConsole()}>
							打开控制台
						</Button>
					</div>
				</section>
			) : null}

			{loggedIn ? (
				<section className="space-y-3 rounded-xl border border-border bg-card p-4">
					<div className="text-[14px] font-medium">最近用量</div>
					{(snapshot?.usage?.length ?? 0) === 0 ? (
						<p className="text-[13px] text-muted-foreground">暂无消费记录</p>
					) : (
						<ul className="space-y-2">
							{snapshot?.usage.slice(0, 15).map((row) => (
								<li key={row.id} className="flex items-center justify-between gap-3 text-[12px]">
									<div className="min-w-0">
										<div className="truncate font-medium">{row.modelName || "未知模型"}</div>
										<div className="text-muted-foreground">
											{row.createdAt
												? new Date(row.createdAt * (row.createdAt < 1e12 ? 1000 : 1)).toLocaleString()
												: "—"}
											{row.group ? ` · ${row.group}` : ""}
										</div>
									</div>
									<div className="shrink-0 text-muted-foreground">
										{row.promptTokens + row.completionTokens} tok
									</div>
								</li>
							))}
						</ul>
					)}
				</section>
			) : null}
		</div>
	);
}
