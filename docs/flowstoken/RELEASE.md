# FlowsToken Desktop 一键发布

## 日常发布

1. 在 `main` 准备客户端版本和 `.github/release-notes/v<版本>.md`，提交并推送。已经公开的版本不能覆盖。
2. GitHub → Actions → **flowstoken-release** → **Run workflow**，选择 `main`，填写可选 `reason`。正常发布不填 `reuse_build_run` 或 `expected_sha`。
3. 流程自动执行 FlowsToken 相关测试、品牌/构建配置检查、四平台打包、Mac 签名公证及 Gatekeeper/票据验证、产物来源/大小/哈希验证，然后核对 GitHub 草稿资产后公开。上游 `desktop-release` 是内部构建步骤，不作为 FlowsToken 的日常发布入口。
4. 服务器每 10 分钟自动校验并镜像到官网更新源，再对齐下载页、安装脚本和阿里云盘。客户端从 `https://www.flowstoken.com/downloads/desktop` 检查更新。

命令行与按钮等价：

```bash
gh workflow run flowstoken-release.yml -R Jacker2099/flowstoken-desktop --ref main -f reason="发布当前版本"
```

## 门禁和失败恢复

- 任何必须检查失败都不会公开新版本。Mac 必须沿用 FlowsToken 的 Developer ID 和 `com.flowstoken.desktop`，保持从 0.6.2 升级的身份一致。
- 等待构建与发布分开计时；失败的 Mac 资料保存为 `failed-macos-*`，仅供诊断，不能当成验证通过的安装包。此流程尚不跨运行自动续接 Apple 公证提交。
- 构建成功、后续发布失败时，可填 `reuse_build_run` 复用同一源码提交的构建；流程核对 SHA、run、attempt、平台和版本。失败平台未完成时不能复用。
- 未公开标签若指向不同提交，流程停止，不自动移动标签。确认没有公开 Release 后，人工备份并处理旧标签，再发布同一版本；已公开版本必须升版本。
- 草稿额外附件可清理，已公开附件不能覆盖。每次发布生成 `release-manifest.json`，将源码/构建与每个文件的 SHA-256 关联。
- 官网镜像中断后，下一轮按持久状态补齐；阿里云上传状态在上传前保存，失败可重试。保留当前版和上一完整版本。网站重新部署后调用镜像脚本的 `--pages-only`，以已验证的本地更新源重新对齐下载版本。

## 上游自动同步

`flowstoken-upstream-sync` 每日计划检查 Open Vetta 的正式 Release；GitHub 定时器可能延迟，不保证精确执行时刻。发现新版本后按三方合并规则保留 FlowsToken 修改、运行门禁、递增客户端版本，并以准确提交 SHA 触发一键发布。

这是一套固定合并规则和自动测试。无法安全解析的冲突会停止并保留独立失败分支/日志，不能替代人工判断任意上游业务变更。已经同步但未公开的版本会重试发布，不重复合并或递增版本；已公开版本直接跳过。

`FT_SYNC_TOKEN` 需要仓库 Contents 和 Workflows 写权限。Apple 签名凭据继续由仓库 Secrets 提供，任何私钥/密码都不进入源码或安装包。

## 发布后验收

确认 GitHub v<版本> 为最新公开版本；三份 latest 清单版本一致；官网引用的文件大小/哈希匹配；Mac ZIP 内应用通过 codesign、Gatekeeper 和 stapler；下载页及安装脚本版本正确；检查服务器镜像状态和阿里云待补传状态。真实登录、付费请求和用户旧版本原地升级应与隔离测试区分记录，不能仅凭 CI 通过宣称它们均已实测。

## 数据兼容

本版本保持现有用户数据根和凭据库身份，避免升级后历史记录或密钥不可见。原版 Vetta 与 FlowsToken 的默认共享数据目录属于既有兼容行为；未来独立数据目录需要专门迁移，不在发版修复中直接改路径。
