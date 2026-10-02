# @vetta/runtime-ssh

SSH 项目的 Coding Agent 工具环境。远端文件、命令和搜索作用于 POSIX 服务端；客户端的工具构造和路径归属合同适用于 Windows、macOS 和 Linux。

远程会话的 `read` 可读取宿主明确列入 `localReadRoots` 的本机附件。原生绝对路径先按宿主
语法核对目录归属，再交给工具解析，因此 Windows drive/UNC 路径不会被拼到远端 cwd 下。
白名单外、相似目录前缀、`..` 越界和 drive-relative 路径仍按远端 POSIX 语义处理；
`write`、`edit` 和搜索始终作用在远端。纯 Win32 路径语法回归不代替 Windows 上实际本机
文件读取的验收。

## 测试平台合同

`bun run test` 保持静态 Bun/Vitest 入口，由 `vitest.config.ts` 按实际宿主选择明确文件清单。新增、遗漏、重复或未分类测试，以及未知宿主平台，都直接失败。没有用 helper 缺失时跳过来获得绿色结果。

| 文件 | 平台 | 验收内容 |
| --- | --- | --- |
| `ssh-tool-environment.test.ts` | 三平台 | 真实工具装配、命令构造、引用、结果/错误解析；外部进程边界用 fake runner，包含实际本机附件读取，不能称作真实 POSIX 信号验收 |
| `project-resource-paths.test.ts` | 三平台 | 原四个 URI/本机 path 合同；不打开 SSH，本机绝对路径使用实际宿主语义 |
| `test/platform-matrix.test.mjs` | 三平台 | 分类、配置接线、inventory 与依赖失败负控；模拟平台参数只测试选择策略，不替代 native 流程 |
| `project-resource-access.test.ts` | macOS/Linux | 真实 loopback 文件读取、stat、目录、符号链接和路径归属 |
| `remote-file-tool-bridge.test.ts` | macOS/Linux | 本机引擎临时处理、远端输出回写、清理及缺失输入错误 |
| `ssh-search-tools.test.ts` | macOS/Linux | 真实 shell 的 rg、fd/fdfind 搜索、引用、行锚点与错误 |
| `ssh-background-command-host.test.ts` | macOS/Linux | 原生通道及 Go helper 后台任务输出、退出、重连和整树停止 |
| `ssh-edit-conflict.test.ts` | macOS/Linux | Go helper 远端读写冲突拒绝及连续编辑 |

POSIX 配置要求 `/bin/sh`、Go、ripgrep 以及 `fd` 或 Debian 的 `fdfind`。helper 两套测试还要求实际编译成功。工具缺失、编译失败与执行失败均使测试退出非零。原 32 个测试的逻辑断言全部保留，其中四个纯路径测试移到全平台文件。

Windows 的真实原生 Node 进程树停止/超时、Git Bash desktop stop/端口复用五套流程继续由 `scripts/flowstoken/test-ssh-platform.mjs` 验收；本包不把 Windows 上的 mock 或 MSYS PID 当作 POSIX endpoint 信号/权限验收。
