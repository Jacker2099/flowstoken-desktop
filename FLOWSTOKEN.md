# FlowsToken Desktop

Branded desktop client based on Open Vetta **lite** (serv-less). Download page: https://www.flowstoken.com/desktop

## Product

- **FlowsToken 账户**（设置页）：登录官网账号后一键启用 **普通组 / 智能组（`Bestoo-Auto`） / 官方组**
  - 自动创建或复用桌面专用 NewAPI 令牌，密钥写入 OS 凭据库 / Electron `safeStorage`（不进安装包）
  - 余额与最近用量可在同一面板刷新查看；可跳转充值与控制台
- 继续保留：文件、终端、浏览器（支付确认）、会话、技能、MCP 自配
- **默认关闭插件市场**（`VETTA_DISABLE_BUILTIN_MARKETPLACE=1`）
- API Base：`https://www.flowstoken.com/v1`
- 「官方组」文案 = 厂商 GPT / Claude 等官方模型，**永不**出现 Vercel / Fireworks

## Security bar

见 `branding/flowstoken/SECURITY.md`。

## Dev (Mac)

```bash
cd ~/src/flowstoken-desktop
bun install
export VETTA_CLOUD_ENABLED=false
export VETTA_HOME="$HOME/.flowstoken-desktop"
export VETTA_DISABLE_BUILTIN_MARKETPLACE=1
export VETTA_PRODUCT_NAME=FlowsToken
export VETTA_APP_ID=com.flowstoken.desktop
export VETTA_EXECUTABLE_NAME=FlowsToken
cd apps/desktop && bun run dev
```

打开 **设置 → FlowsToken 账户**，登录一次即可完成三组接入。

## Package / CI

`apps/desktop/scripts/desktop-build-environment.mjs` 的 opensource 默认已烘焙：

- `VETTA_PRODUCT_NAME=FlowsToken`
- `VETTA_APP_ID=com.flowstoken.desktop`
- `VETTA_EXECUTABLE_NAME=FlowsToken`
- `VETTA_CLOUD_ENABLED=false`
- `VETTA_DISABLE_BUILTIN_MARKETPLACE=1`
- 更新源：`Jacker2099/flowstoken-desktop`

本地打包：

```bash
cd apps/desktop && bun run dist:opensource
```

图标源：`branding/flowstoken/assets/` → `apps/desktop/build/icon.{png,icns,ico}`。

## Wire providers（手动兜底）

若无法登录，仍可按 `branding/flowstoken/SETUP.md` 手动粘贴密钥到三组预设。

## Upstream

合并 Open Vetta 时务必保留本文件与 `UPSTREAM.md` 中列出的 FlowsToken 叠加层（账户服务、预设、品牌与市场关闭）。
