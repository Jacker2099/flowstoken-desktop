# FlowsToken Desktop — 接入三组（推荐路径）

## 一键登录（推荐）

1. 首次启动在登录页使用官网账号登录；0.6.3 会自动打开一次官方登录窗口，关闭后可手动重试
2. 登录后进入 **设置 → FlowsToken 账户** 管理分组密钥和余额
3. 登录成功后自动：
   - 为 **普通组 (`default`) / 智能组 (`smart`) / 官方组 (`vip`)** 创建或复用桌面专用令牌
   - 将密钥写入系统凭据库，并启用对应预设服务商
   - 展示余额与最近用量（可刷新）
4. 智能组默认模型：`Bestoo-Auto`
5. Base URL：`https://www.flowstoken.com/v1`（HTTPS）

## 登录后手动配置

此路径用于已登录后的密钥维护，不绕过客户端的账户登录门禁。

1. 浏览器打开 https://www.flowstoken.com/console/token 并登录
2. 按组创建密钥后，在 **设置 → 模型配置 → 预设服务商** 中填入对应 FlowsToken 预设
3. 不要开启插件市场；不要设置 `VETTA_DEV_AUTO_APPROVE_ACTIONS=1`

## NewAPI 对照

| UI | group | 说明 |
|----|-------|------|
| 普通组 | `default` | 普通模型组，具体目录与供应商由服务端维护 |
| 智能组 | `smart` | `Bestoo-Auto` |
| 官方组 | `vip` | 厂商官方模型（GPT/Claude），文案禁止 Vercel/Fireworks |

会话 Cookie 保存在 Electron partition `persist:flowstoken-account`；API 密钥只进 safeStorage。
