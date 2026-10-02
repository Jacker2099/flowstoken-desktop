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
- 更新源：自 0.6.0 起为 `https://www.flowstoken.com/downloads/desktop`（`branding/flowstoken/update-feed.mjs`，CI 经 `resolve-desktop-release-config.mjs` 注入 generic provider）；GitHub Releases 仍是制品仓库并承接 ≤0.5.61 老客户端的升级

本地打包：

```bash
cd apps/desktop && bun run dist:opensource
```

图标源：`branding/flowstoken/assets/` → `apps/desktop/build/icon.{png,icns,ico}`。

## 账户与模型同步

客户端先登录 FlowsToken 账户，随后自动创建或复用三组桌面专用令牌。普通、智能、官方的模型目录、厂商分组、排序与 NEW 标记从官网同步；离线沿用缓存。手动参数与自定义 Provider 保留，手动密钥不能绕过账户登录。

## Upstream

合并 Open Vetta 时务必保留本文件与 `UPSTREAM.md` 中列出的 FlowsToken 叠加层（账户服务、预设、品牌与市场关闭）。

0.6.4 同步已发布的 Open Vetta 0.5.60。后续可选择完整发布同步或按模块吸收核心修复；自主品牌、产品层与许可证边界见 [维护策略](docs/flowstoken/UPSTREAM_POLICY.md)。

## 自动发版

本轮自动上游同步保持手动停用。日常模型与分组显示从官网 schema2 目录同步，不需要安装包更新；账户权限与计费身份继续由认证接口和受管令牌决定。0.6.4 的最终发布门禁包含三平台完整源码测试、平台适用 SSH 合同、四平台构建与严格安装/更新验证，不以历史 related 检查替代。

见 `UPSTREAM.md`「Automatic sync」：每日自动合并上游正式版 → 检查全过自动发版 → 服务器 10 分钟内镜像上线。自有功能改动：改完 bump `apps/desktop/package.json` 版本、写发布说明、推 main，然后手动运行 `flowstoken-release` 工作流。自 0.6.2 起 macOS 包使用 Developer ID（MIN WANG, Team 36G5T56368）签名并经 Apple 公证，凭据在仓库 secrets `MACOS_CERTIFICATE_P12_BASE64` / `MACOS_CERTIFICATE_PASSWORD` / `APPLE_API_KEY_P8_BASE64` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` / `APPLE_TEAM_ID`；`flowstoken-release` 拒绝发布未签名的 Mac 包。≤0.6.1 的未签名 Mac 客户端无法原地安装签名版，需从官网手动下载一次，之后自动更新恢复正常。证书 2031-09-17 到期；更换证书或 API 密钥时只需更新上述 secrets。
