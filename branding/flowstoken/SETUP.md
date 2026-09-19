# FlowsToken Desktop — 接入三组（推荐路径）

## 一键登录（推荐）

1. 打开 Desktop → **设置 → FlowsToken 账户**
2. 使用官网账号登录（应用内表单或浏览器登录）
3. 登录成功后自动：
   - 为 **普通组 (`default`) / 智能组 (`smart`) / 官方组 (`vip`)** 创建或复用桌面专用令牌
   - 将密钥写入系统凭据库，并启用对应预设服务商
   - 展示余额与最近用量（可刷新）
4. 智能组默认模型：`Bestoo-Auto`
5. Base URL：`https://www.flowstoken.com/v1`（HTTPS）

## 手动粘贴（兜底）

1. 浏览器打开 https://www.flowstoken.com/console/token 并登录
2. 按组创建密钥后，在 **设置 → 模型配置 → 预设服务商** 中填入对应 FlowsToken 预设
3. 不要开启插件市场；不要设置 `VETTA_DEV_AUTO_APPROVE_ACTIONS=1`

## NewAPI 对照

| UI | group | 说明 |
|----|-------|------|
| 普通组 | `default` | 双通道高可用 |
| 智能组 | `smart` | `Bestoo-Auto` |
| 官方组 | `vip` | 厂商官方模型（GPT/Claude），文案禁止 Vercel/Fireworks |

会话 Cookie 保存在 Electron partition `persist:flowstoken-account`；API 密钥只进 safeStorage。
