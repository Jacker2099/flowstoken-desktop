# Apple 证书申请与 macOS 签名/公证手册

面向 Vetta 桌面端 macOS 发版：从零申请公司主体的 Apple 开发者账号，拿到 **Developer ID Application** 证书与公证凭据，注入构建，直到用户双击 DMG 不再看到「已损坏」。

构建侧改动见 `apps/desktop/scripts/prepare-pack.js` 的 `resolveMacSigning()`。**只要环境变量齐全就自动开启签名+公证，一个都不设就是现在的未签名产物**，不需要改代码。

---

## 0. 需要拿到什么

最终要凑齐这几样，缺一不可：

| 产物 | 用途 | 来源 |
|---|---|---|
| Apple Developer Program 会员资格（Organization） | 前提，$99/年 | developer.apple.com |
| **Developer ID Application** 证书 + 私钥（`.p12`） | 给 `Vetta.app` 签名 | 开发者后台创建，本机钥匙串导出 |
| **Team ID**（10 位，如 `A1B2C3D4E5`） | 公证时指定团队 | 开发者后台 Membership 页 |
| App Store Connect **API Key**（`.p8`）或 **App 专用密码** | 提交公证 | App Store Connect / appleid.apple.com |

> **不要用** Development / Apple Distribution / Mac App Distribution 证书。分发到 App Store 之外（我们就是）只认 **Developer ID Application**。Mac App Store 是另一条完全不同的链路。

---

## 1. 申请公司开发者账号（Organization）

耗时最长的一段，**先启动这一步**，其余都是几分钟的事。

### 1.1 先拿 D-U-N-S 编号

Apple 用邓白氏（D-U-N-S）编号核验公司法人存在，个人账号不需要，公司账号必须有。

1. 打开 <https://developer.apple.com/enrollment/duns-lookup/>
2. 按营业执照上的**英文名称**、地址、法人信息查询是否已有编号——很多公司早已被邓白氏收录，直接查到就不用申请
3. 查不到就在页面上提交申请，免费。Apple 页面标称 5 个工作日，实际中国大陆主体 **1～3 周**是常态，可能会有邓白氏的电话或邮件回访核实
4. 拿到编号后建议先在同一页面复查一遍：公司英文名、地址必须与后面注册时**逐字一致**，不一致会被打回重来

需要准备的信息（提前对齐，改起来很慢）：

- 公司英文名称：必须与营业执照上的英文名或其标准音译一致
- 公司英文地址
- 公司官网域名：**必须能访问、且域名归属公司**。Apple 人工审核会打开网站确认公司真实存在
- 公司座机（Apple 可能回拨核验）
- 法人 / 授权签署人姓名与职务

### 1.2 注册开发者账号

1. 用**公司邮箱**注册 Apple ID（不要用个人 Apple ID，账号后续与公司资产绑定，离职交接会很痛苦）
2. 该 Apple ID 必须开启**双重认证**，否则无法进入注册流程
3. 打开 <https://developer.apple.com/programs/enroll/>，选 **Company / Organization**
4. 填入 D-U-N-S 编号、公司信息，勾选「我有权代表公司签署法律协议」
5. 支付 $99/年（需要 Visa / Mastercard 等国际信用卡）

审核期通常 1～5 个工作日，Apple 可能来电核实。审核通过后邮箱收到激活通知。

### 1.3 确认角色权限

进入 <https://developer.apple.com/account> → **Membership details**：

- 记下 **Team ID**（10 位大写字母数字），后面 `APPLE_TEAM_ID` 就是它
- 确认自己的角色是 **Account Holder** 或 **Admin**。只有这两个角色能创建 Developer ID 证书（Developer 角色不能）

---

## 2. 创建 Developer ID Application 证书

**在准备用来签名的那台 Mac 上操作**——私钥只存在于生成 CSR 的那台机器的钥匙串里。

### 2.1 生成 CSR

1. 打开「钥匙串访问」（Keychain Access）
2. 菜单 → 证书助理 → **从证书颁发机构请求证书**
3. 填写：
   - 用户电子邮件地址：注册用的公司邮箱
   - 常用名称：随便写，如 `Vetta Developer ID`
   - CA 电子邮件地址：**留空**
   - 请求方式：勾选 **存储到磁盘**，并勾选 **让我指定密钥对信息**
4. 下一步，密钥大小 **2048 位**，算法 **RSA**
5. 保存 `CertificateSigningRequest.certSigningRequest`

### 2.2 在后台签发

1. <https://developer.apple.com/account/resources/certificates/list> → 左上 **+**
2. 类型选 **Developer ID Application**
   - 若出现 profile type 选择，选 **G2 Sub-CA (Xcode 11 or later)**
3. 上传刚才的 `.certSigningRequest`
4. 下载生成的 `developerID_application.cer`，**双击导入钥匙串**

> 单个团队的 Developer ID 证书数量有硬上限（历史上是 5 个，且**无法自行吊销重置**）。不要为每个人各签一张，团队共用一张、以 `.p12` 形式受控分发。

### 2.3 导出 .p12

1. 钥匙串访问 → 「登录」钥匙串 → 「我的证书」
2. 找到 `Developer ID Application: <公司名> (<TeamID>)`，展开左侧三角能看到配套私钥——**看不到私钥说明这台机器不是生成 CSR 的机器，导出的东西不能用**
3. 右键 → 导出 → 格式 **个人信息交换 (.p12)**
4. 设一个强密码（这就是后面的 `CSC_KEY_PASSWORD`），保存为 `developer-id.p12`

`.p12` + 密码 = 可以冒充公司签名的一切。存进密码管理器 / CI Secret，**绝不进 git**。

---

## 3. 准备公证凭据

公证（notarization）是把签好名的产物传给 Apple 扫描，换回一张票据（ticket）钉进应用包（`.app`），再生成 DMG / ZIP。两种鉴权方式选其一，推荐 API Key。

### 方式 A：App Store Connect API Key（推荐，CI 友好）

1. <https://appstoreconnect.apple.com/access/integrations/api> → **团队密钥 (Team Keys)** 标签
2. 生成密钥，角色选 **Developer**（够用，不需要 Admin）
3. 记下 **Issuer ID**（UUID 形式）与 **Key ID**（10 位）
4. 下载 `AuthKey_<KeyID>.p8`——**只能下载一次**

对应三个变量：`APPLE_API_ISSUER`、`APPLE_API_KEY_ID`、`APPLE_API_KEY`（`.p8` 文件路径）。

优点：不绑定个人 Apple ID，成员离职不失效；可随时单独吊销。

### 方式 B：App 专用密码

1. <https://appleid.apple.com> → 登录 → 「登录与安全」→ **App 专用密码**
2. 生成一个，格式 `xxxx-xxxx-xxxx-xxxx`，**只显示一次**

对应两个变量：`APPLE_ID`（Apple ID 邮箱）、`APPLE_APP_SPECIFIC_PASSWORD`。

缺点：绑定个人 Apple ID，该账号密码变更或退出团队后公证立刻失败。

---

## 4. 注入构建

所有变量**只通过 shell 环境或 CI Secret 注入，不写进任何 `.env` 文件**（`.env*` 会被构建脚本读取并可能进产物）。

```bash
# 证书
export CSC_LINK="$HOME/secrets/developer-id.p12"   # 也可用 base64 字符串（CI 常用）
export CSC_KEY_PASSWORD='<导出 .p12 时设的密码>'

# 团队
export APPLE_TEAM_ID='A1B2C3D4E5'

# 公证 —— 方式 A
export APPLE_API_ISSUER='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
export APPLE_API_KEY_ID='XXXXXXXXXX'
export APPLE_API_KEY="$HOME/secrets/AuthKey_XXXXXXXXXX.p8"

# 公证 —— 方式 B（与 A 二选一）
# export APPLE_ID='ci@yourcompany.com'
# export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'

cd apps/desktop
bun run dist:mac
VETTA_REQUIRE_MAC_SIGNATURE=1 bun run verify:updates:mac
```

CI 上 `CSC_LINK` 可以直接放 base64：`export CSC_LINK="$(base64 -i developer-id.p12)"`。

构建脚本的行为：

- **一个相关变量都没设** → 本地或非发布演练走未签名路径（`identity: "-"` / `notarize: false`），DMG 里带「修复已损坏.app」；正式发布拒绝未签名产物
- **设了一部分** → 直接报错并列出缺哪些，不会产出「签了名但没公证」这种半成品
- **全齐** → 开启 hardened runtime + entitlements + 公证，DMG 变回两图标常规版式，不再带修复助手

签名+公证会让 `dist:mac` 明显变慢：产物里内置了 Node / Python 运行时与多个 sidecar 二进制，需要逐个签名再上传；Apple 的处理时长与排队情况独立于本地构建时长，等待超时不代表审核被拒绝。

---

### 4.1 换一台 Mac 打包

`mac-signing.env` 存的是路径不是凭据本体，换机器要带的是这三样：

| 项 | 说明 |
|---|---|
| `developer-id.p12` | 签名私钥 |
| `AuthKey_<KeyID>.p8` | 公证密钥 |
| `~/.config/vetta/mac-signing.env` | 复制过去，`VETTA_SIGNING_DIR` 改成新机器上的实际目录 |

凭据放在移动硬盘、且挂载点相同的话，env 文件一个字都不用改。

新机器还需要：Xcode Command Line Tools（`codesign` / `notarytool` / `swiftc` / `osacompile`）、Bun、Node、Go，以及 Apple 中间证书（缺了报 `0 valid identities`，见故障排查）。

就绪自检：

```bash
source ~/.config/vetta/mac-signing.env      # 不报「找不到 ...」= 路径对
security find-identity -v -p codesigning    # 1 valid identity
xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
```

### 4.2 GitHub Actions 注入

`.github/workflows/desktop-release.yml` 已接入签名与公证。仓库需要配置以下 Actions Secrets：

| Secret | 内容 |
|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | `developer-id.p12` 的 base64 内容 |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_KEY_P8_BASE64` | `AuthKey_<KeyID>.p8` 的 base64 内容 |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID |
| `APPLE_API_ISSUER` | App Store Connect Issuer ID |
| `APPLE_TEAM_ID` | Developer Program Team ID |

macOS 在 matrix 里是 `dist:mac:arm64` 与 `dist:mac:x64` 两个任务（内置的 node/python 运行时按 `VETTA_VENDOR_PLATFORM` 单架构落盘，一次构建出不了两套），分别跑在 `macos-15` 与 `macos-15-intel` 托管 runner 上，两者各自签名公证并校验，产物元数据以 `latest-mac-<arch>.yml` 上传，由发布任务的 `merge:updates:mac` 合并回单一 `latest-mac.yml`。

公证不需要专用签名机：`notarytool` 把签好名的产物传给 Apple 换票据，托管 runner 有网络即可。工作流会在 runner 的临时目录还原 `.p12` 和 `.p8`（`chmod 600`），仅通过环境变量使用，构建结束随 runner 销毁。**tag 和发布型手动构建必须具备完整签名、公证凭据；FlowsToken 外层发布也拒绝未签名的构建检查点。** 只有非发布的 `workflow_dispatch` 演练在完全没有签名变量时允许未签名包；只配置一部分仍直接失败。凭据齐全的演练同样签名、公证并设置 `VETTA_REQUIRE_MAC_SIGNATURE=1`。此门禁下 `VETTA_SKIP_NOTARIZE=1` 不合法；仅限未要求正式签名验收的本地实验使用该开关。

### 4.3 保留一次提交并恢复公证

`prepare-pack.js` 对需要公证的签名构建设置唯一的 `afterSign` hook：`scripts/notarize-mac-app.mjs`。electron-builder 内置 `mac.notarize` 关闭，是为了把执行交给此 hook，而不是跳过公证；`macSigning.notarize` 和 `VETTA_REQUIRE_MAC_SIGNATURE` 的要求不变。hook 返回成功后，builder 才继续生成 DMG / ZIP。

执行顺序：

1. 深度验证签名，核对 bundle ID、版本、Team ID、架构和各架构 CDHash；生成不可重写的待提交 ZIP。
2. 在 `release/<Mac 输出目录>/notarization/receipt.json` 原子保存并同步到磁盘的 `submitting` 回执，再执行一次 `notarytool submit --no-wait --output-format json`。获取 UUID 后立即保存 `submitted` 回执。该目录保留提交 ZIP，可随失败构建归档恢复，不包含 `.p8`、`.p12`、密码或访问令牌。
3. 仅对同一个 UUID 执行 `notarytool info`；网络错误有限次退避重试。默认状态等待预算 180 分钟，单次查询最多 2 分钟。到达预算、持续断网或异常状态均阻止构建继续，保留原提交；Apple 后台不会因此取消审核。
4. `Invalid` / `Rejected` 立即失败。`Accepted` 后读取该 UUID 的 Apple 日志，核对日志 ID、已知提交 ZIP 的 SHA-256，以及根 `.app` 的各架构 CDHash。任意一个 `Accepted` UUID 不能代替当前应用的公证。
5. 票据匹配后才执行 `stapler staple`，再次运行 `codesign --verify --deep --strict` 和 `stapler validate`，全部通过才把回执标为 `stapled`。回执中的 `acceptance` 只保存用于核验的提交 ID、归档名、SHA-256 和签名摘要。外层 ZIP / Gatekeeper、packaged E2E、产物来源和更新清单门禁继续执行。

如果 `submit` 超时、退出异常或未返回可解析 UUID，回执会标为 `needs-review`。这表示 Apple 可能已接收上传；后续执行不得自动重投。先从同次原始输出或 Apple 提交记录核对原 UUID，再显式恢复。不要删除回执、重新签名或重新执行完整 `dist:mac` 来重试状态查询。

恢复已有回执或旧构建中已知 UUID 的签名应用时，使用以下入口（路径、标识、版本和 UUID 必须替换成已核验的原产物信息；凭据仍取本节环境变量）：

```bash
node apps/desktop/scripts/notarize-mac-app.mjs \
  --app '/path/to/release/mac-arm64/FlowsToken.app' \
  --state-dir '/path/to/release/mac-arm64/notarization' \
  --expected-bundle-id com.flowstoken.desktop \
  --expected-version 0.6.3 \
  --expected-team-id "$APPLE_TEAM_ID" \
  --expected-arch arm64 \
  --submission-id '<原提交 UUID>' \
  --resume-only \
  --timeout-seconds 1200
```

已有回执含 UUID 时可省略 `--submission-id`；外部 UUID 必须与 `--resume-only` 一起使用。此模式绝不执行 `submit`，也不需要重新导入签名私钥。带原 ZIP 信息的 `needs-review` 回执会保留其 SHA-256 绑定，不会因为人工补入 UUID 而丢失。

跨 runner 恢复前必须先核对原 artifact 的 SHA / run / attempt / digest，并在 macOS 上用原生 `tar` 解包，保留应用的符号链接、权限和资源 fork；通用解包器留下的 `._*` 文件可能破坏严格验签。保留的失败 `.app` 仅是待验收输入，不能当作已通过检查点。恢复成功后使用 `--prepackaged` 包装同一 `.app`，重建 DMG / ZIP、blockmap 和更新元数据，再通过正式恢复工作流的全部门禁；不能重新编译或重新签名替换原应用。

## 5. 验证

拿到 `apps/desktop/release/Vetta-<version>.dmg` 后逐条跑：

```bash
# 1. 挂载 DMG
hdiutil attach release/Vetta-*.dmg

# 2. 公证票据已钉进 app
xcrun stapler validate /Volumes/Vetta*/Vetta.app
# 期望：The validate action worked!
#
# 注意校验对象是 app 不是 DMG：electron-builder 的顺序是「签 app → 公证 app →
# 钉票据 → 再打 DMG」，容器本身从未被提交公证，对 DMG 跑这条命令必定报
# "does not have a ticket stapled to it"，那是预期行为，不是失败。
# 影响仅限「首次打开 DMG 时完全断网」会多一次 Gatekeeper 警告；
# app 已钉票据，装好后离线启动不受影响。

# 3. 检查 app 签名
codesign -dv --verbose=4 /Volumes/Vetta*/Vetta.app
# 期望：Authority=Developer ID Application: <公司名> (<TeamID>)
#       flags 里含 runtime（= hardened runtime 生效）
#       TeamIdentifier=<TeamID>，不是 not set

# 4. 深度校验所有嵌套二进制
codesign --verify --deep --strict --verbose=2 /Volumes/Vetta*/Vetta.app
# 期望：valid on disk / satisfies its Designated Requirement

# 5. Gatekeeper 放行
spctl -a -vvv -t install /Volumes/Vetta*/Vetta.app
# 期望：accepted，source=Notarized Developer ID

hdiutil detach /Volumes/Vetta*
```

最后必须做一次**真机端到端验证**：把 DMG 上传到 CDN，从**另一台没装过开发者证书的 Mac** 用浏览器下载（一定要走浏览器，`scp`/AirDrop 不会打 quarantine 标记，测不出问题），拖入 `/Applications` 双击——应该直接启动，不出现任何「已损坏」「无法验证开发者」弹窗。

自动更新还要额外验证一次：安装旧的签名版本，从 R2/GitHub 检查并下载新版本；界面只有在 Squirrel.Mac 完成暂存后才应提示重启。重启后确认版本号、应用功能和内置 Node/Python runtime 都来自新版本。macOS 更新要求前后版本使用同一 Developer ID 身份和一致的应用标识，不能用未签名旧包验证正式签名更新。

---

## 6. 故障排查

**`Command failed: codesign ... The specified item could not be found in the keychain`**

`.p12` 里没有私钥，或 `CSC_KEY_PASSWORD` 错。回 2.3 确认导出时钥匙串里能展开看到私钥。

**公证返回 `Invalid`，`xcrun notarytool log <submissionId>` 显示 `The binary is not signed with a valid Developer ID certificate`**

产物里有没签到的嵌套 Mach-O 二进制。Vetta 在 `Contents/Resources/` 下带了 `im-gateway`、`cli-host`、`vendor/node`、`vendor/python`、`appshot` 等一堆可执行文件，日志会指出具体是哪个路径。查看完整日志：

```bash
xcrun notarytool log <submissionId> \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
```

排查时可以先 `VETTA_SKIP_VENDOR=1 bun run dist:mac` 把内置运行时摘掉，确认是不是 vendor 里的二进制导致，再针对性处理。

**公证返回 `Invalid`，日志说 `The executable does not have the hardened runtime enabled`**

某个二进制签名时没带 `--options runtime`。检查 `apps/desktop/build/entitlements.mac.plist` 是否存在且被 `mac.entitlements` 指到。

**App 启动即闪退，控制台报 `code signature invalid` / `library load disallowed by system policy`**

原生模块（`uiohook-napi`、`electron-liquid-glass`、photon 的 wasm）加载被拦。确认 entitlements 里有 `com.apple.security.cs.disable-library-validation`。

**公证通过但用户仍报「已损坏」**

- 先确认用户下载的是**新版本**——已发布的旧 DMG 不会追溯获得票据
- 让用户跑 `xattr -l /Applications/Vetta.app`，若只有 `com.apple.quarantine` 而 app 是公证过的，通常是下载过程被网络中间设备改写导致签名失效，换直链或换网络重下

**`Team ID` 填错**

`APPLE_TEAM_ID` 必须与证书 `Authority` 括号里的那串完全一致。填错时公证会报 `Unable to find team`。

**证书过期**

Developer ID Application 证书有效期 5 年。**已公证的历史产物不受影响**（票据不随证书过期失效），但过期后无法签新版本。到期前重新走一遍第 2 节即可，`.p12` 与相关 Secret 一并更新。

---

## 7. 相关文件

| 路径 | 作用 |
|---|---|
| `apps/desktop/scripts/prepare-pack.js` | `resolveMacSigning()` 决定开不开签名；生成 electron-builder 配置 |
| `apps/desktop/build/entitlements.mac.plist` | 主 app 的 hardened runtime entitlements |
| `apps/desktop/build/entitlements.mac.inherit.plist` | 子进程继承用 entitlements |
| `apps/desktop/scripts/build-mac-repair-helper.js` | 「修复已损坏.app」，仅未签名构建使用 |
| `docs/adr/0003-dmg-repair-helper.md` | 未签名时期修复助手的决策背景 |
