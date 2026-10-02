# FlowsToken Desktop 一键发布

## 日常发布

1. 在 `main` 准备客户端版本和 `.github/release-notes/v<版本>.md`，提交并推送。已经公开的版本不能覆盖。
2. GitHub → Actions → **flowstoken-release** → **Run workflow**，选择 `main`，填写可选 `reason`。正常发布不填 `reuse_build_run` 或 `expected_sha`。
3. 流程自动执行 FlowsToken 相关测试、品牌/构建配置检查、四平台打包、Mac 签名公证及 Gatekeeper/票据验证、四平台独立安装包检查和真实 packaged/updater E2E、产物来源/大小/哈希验证，然后核对 GitHub 草稿资产后公开。上游 `desktop-release` 是内部构建步骤，不作为 FlowsToken 的日常发布入口。
4. 服务器每 10 分钟自动校验并镜像到官网更新源，再对齐下载页、安装脚本和阿里云盘。客户端从 `https://www.flowstoken.com/downloads/desktop` 检查更新。

命令行与按钮等价：

```bash
gh workflow run flowstoken-release.yml -R Jacker2099/flowstoken-desktop --ref main -f reason="发布当前版本"
```

## 门禁和失败恢复

- 任何必须检查失败都不会公开新版本。Mac 必须沿用 FlowsToken 的 Developer ID 和 `com.flowstoken.desktop`，保持从 0.6.2 升级的身份一致。
- 质量检查、四个平台 build 和四个平台 verify 必须全部成功；E2E 使用严格退出码，失败、取消、跳过或尚未完成都不能发布。
- 父构建任务上限 360 分钟，等待门禁上限 340 分钟，发布单独上限 60 分钟。失败的 Mac 资料保存为 `failed-macos-*`，仅供诊断，不能当成验证通过的安装包。失败运行不会自行恢复发布；保留原签名应用时，可使用下方显式恢复入口继续原 Apple 请求。
- 全部构建和验证成功、后续发布失败时，可填 `reuse_build_run` 复用同一源码提交的构建；流程核对 SHA、run、attempt、平台和版本。任一平台构建或验证未通过时不能复用；源码改变后必须重新构建，不能复用前一个候选提交的制品。
- 未公开标签若指向不同提交，流程停止，不自动移动标签。确认没有公开 Release 后，人工备份并处理旧标签，再发布同一版本；已公开版本必须升版本。
- 草稿额外附件可清理，已公开附件不能覆盖。每次发布生成 `release-manifest.json`，将源码/构建与每个文件的 SHA-256 关联。
- 官网镜像中断后，下一轮按持久状态补齐；阿里云上传状态在上传前保存，失败可重试。保留当前版和上一完整版本。网站重新部署后调用镜像脚本的 `--pages-only`，以已验证的本地更新源重新对齐下载版本。

## 保留原签名应用和公证请求的恢复

恢复必须明确区分两份提交：`controllerSha` 是运行恢复流程的提交（也是新 GitHub run 的 `head_sha`）；`sourceSha` / `sha` 是原应用源码提交。版本标签继续指向原应用提交，不移动标签，也不把新控制代码伪装成应用源码。

1. 原 `desktop-release` 运行必须已经结束，提供准确的 `recovery_source_run`、`recovery_source_attempt`、`recovery_source_sha`。恢复准备阶段固定四个平台的原 artifact ID、GitHub ZIP SHA-256、大小及原 job ID；过期、缺失、来源不符或原运行后来重跑都会停止。
2. 原 Windows/Linux 完整 checkpoint 可复用。失败的 Mac 构建还需填写对应 `recovery_arm64_submission` / `recovery_x64_submission`；ID 必须与该原 job 日志里唯一的公证请求一致。只读取并恢复原 `.app`，不重新编译、签名或调用 `submit`。
3. 先从新的控制代码分支运行 `desktop-release`，传以上恢复输入，并保留 `channel=default`、`release_target=github`，不覆盖应用版本。原源码实际执行质量检查；控制脚本复制到 `RUNNER_TEMP` 后独立测试，避免混入原源码检查或依赖安装。
4. Mac 原请求必须 `Accepted`，Apple 日志里的签名摘要必须匹配原应用，随后 staple、验签并生成 DMG/ZIP；应用复制到 checkpoint 后再次核对 CDHash。打容器会产生新文件哈希，manifest 如实记录。仍为 `In Progress` 或网络错误时只有限等待，失败可再次恢复同一 ID，不自动新增公证提交。
5. 四个恢复 build 仍实际运行平台安装包校验；随后四个平台 verify/packaged/updater E2E 全部执行。质量检查、四 build、四 verify 共九项必须成功，失败归档不会被改名为正式 checkpoint。
6. 候选恢复运行全部通过后，从**同一 controller 提交**运行 `flowstoken-release`，填写同一组恢复输入，并把 `reuse_build_run` 设为这次新恢复运行 ID。普通 `reuse_build_run` 不放宽同提交限制，不能填写原失败运行来跳过检查。

恢复 E2E 将应用和验证工具分别固定：应用始终来自原 source SHA 的 checkpoint；WDIO 配置、完整 E2E specs/fixture 和两个运行 helper 来自新的 controller SHA。验证时在 `RUNNER_TEMP` 创建独立 `verification-harness`，复制原 source 的 `package.json` 作为原版本及严格 `test:e2e` 入口元数据，依赖链接到原 source 按锁文件安装的 `node_modules`，通过 `VETTA_E2E_PACKAGED_ROOT` 指向原产物。恢复时不会把新测试覆盖进旧源码，也不会重写原 package.json、修改应用或重新签名。

每个平台另外上传 `verification-tooling-*` 诊断 manifest，记录 controller/tooling SHA、原 source SHA、版本、运行/attempt、测试文件摘要和原依赖锁摘要。其 `phase=prepared` 只表示验证工具已准备，不能作为测试成功证明；真实 verify/E2E 失败仍阻断发布，原 build checkpoint 不被该工具清单改写。这样可以修正测试工具本身的缺陷后，继续严格验证同一个原签名应用。

新 checkpoint / `release-manifest.json` 同时记录 source SHA、controller SHA、新 run/attempt、原 run/attempt、artifact ID/digest、Mac 原 submission 及 Accepted/stapled/CDHash 证明。发布前再次核对来源和原标签。原运行始终保持它真实的失败状态。

恢复 E2E 使用独立 `RUNNER_TEMP/verification-harness`：WDIO 配置、specs/fixture 和两个 helper 来自 controller SHA；版本及严格测试入口元数据复制自原 source 的 package.json，依赖链接到原 source 按锁文件安装的 node_modules。`VETTA_E2E_PACKAGED_ROOT` 仍指向该任务恢复的原应用产物；新测试不会覆盖进旧 source，恢复时只核对原 package.json 版本，不重写它。

每个平台另上传 `verification-tooling-*` 诊断 manifest，记录 controller/tooling SHA、source SHA、原版本、测试文件摘要、原依赖锁摘要以及运行/attempt。`phase=prepared` 只表示工具准备完成，不能代替真实 verify/E2E 的成功结论，也不会改写原 build checkpoint。准备 helper 不修改受追踪 source 或原签名 Mac.app；Linux E2E 保留已有行为，允许清理该 verify job 工作副本中的 package-type marker，AppImage 测试使用临时副本，正式发布资产仍来自不可变 build checkpoint。

CI 使用 Python 3.12 预检查归档成员，真正解包采用平台原生 tar：macOS 使用 `/usr/bin/tar` 合并 AppleDouble 元数据；Windows 固定 `%SystemRoot%\System32\tar.exe`，避免 Git GNU tar 错读盘符路径。本地运行恢复归档测试需提供 Python 3.12+，例如 `RECOVERY_PYTHON=python3.12 node --test branding/flowstoken/tests/recovery-ci.test.mjs`。

## 上游自动同步

`flowstoken-upstream-sync` 每日计划检查 Open Vetta 的正式 Release；GitHub 定时器可能延迟，不保证精确执行时刻。发现新版本后按三方合并规则保留 FlowsToken 修改、运行门禁、递增客户端版本，并以准确提交 SHA 触发一键发布。

这是一套固定合并规则和自动测试。无法安全解析的冲突会停止并保留独立失败分支/日志，不能替代人工判断任意上游业务变更。已经同步但未公开的版本会重试发布，不重复合并或递增版本；已公开版本直接跳过。

`FT_SYNC_TOKEN` 需要仓库 Contents 和 Workflows 写权限。Apple 签名凭据继续由仓库 Secrets 提供，任何私钥/密码都不进入源码或安装包。

## 发布后验收

确认 GitHub v<版本> 为最新公开版本；三份 latest 清单版本一致；官网引用的文件大小/哈希匹配；Mac ZIP 内应用通过 codesign、Gatekeeper 和 stapler；下载页及安装脚本版本正确；检查服务器镜像状态和阿里云待补传状态。真实登录、付费请求和用户旧版本原地升级应与隔离测试区分记录，不能仅凭 CI 通过宣称它们均已实测。

## 数据兼容

本版本保持现有用户数据根和凭据库身份，避免升级后历史记录或密钥不可见。原版 Vetta 与 FlowsToken 的默认共享数据目录属于既有兼容行为；未来独立数据目录需要专门迁移，不在发版修复中直接改路径。
