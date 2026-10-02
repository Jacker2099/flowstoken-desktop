# @vetta/ssh-transport

远程项目的 SSH 传输层：主机模型、连接复用、远端命令执行与文件操作。

架构决策见 [ADR-0124](../../docs/adr/0124-ssh-remote-projects-and-execution-boundary.md)。

## 边界

本包**只**负责「把一条命令或一次文件读写送到远端并把结果带回来」。它不知道项目、
会话、Agent 或 Electron 的存在，也不做任何本地文件 I/O。

## 关键约定

### 项目标识是带 scheme 的 URI

远程项目的 cwd 是 `ssh://<hostId>/<绝对路径>`。Desktop 把 cwd 字符串当作项目与会话的
主键（会话分片目录、活动标签 keying、侧边栏展开集合），用 URI 能让这些地方原样工作，
只有真正做 I/O 的边界才需要 `parseProjectLocation`。

解析不使用 `new URL()`——它会百分号编码路径，同一个远端路径在「用户输入」与「往返
一次之后」会得到两个字符串，主键随之分裂。

### 失败分三类，不许合并

| 错误 | verdict | 含义 |
| --- | --- | --- |
| `SshTransportError` | `unverifiable` | 连接层失败，没拿到任何远端答复 |
| `SshOperationAbortedError` | `unverifiable` | 取消或超时，远端可能已执行完 |
| `SshRemoteCommandError` | `exited` | 远端确实执行了并返回非零 |

把传输故障当成「远端说没有」的后果是具体的：网络抖一下，文件树显示目录为空，Agent
以为文件不存在并重新创建一遍。

`RemoteProjectNotSupportedError` 用于让「静默回退到本地」变成可见崩溃——本机很可能
存在同名路径，本地执行会对着完全不同的仓库给出看起来成功的答案。

### 命令构造集中在一处

`remote-command.ts` 是整条链路上唯一允许拼接命令字符串的地方。路径来自用户选择的
目录、模型给出的参数和远端目录列表，任何一处漏引号都是一次任意命令执行。

两层引用要分开理解：`buildRemoteScript` 产出交给登录 shell 的脚本，
`buildRemoteCommand` 再把整段脚本作为 `-c` 的单个参数引用一次。

### 用户命令走登录 shell，内部操作不走

`exec()` 用 `$SHELL -l -c`，因为 nvm、pyenv、asdf 只在 `~/.profile` 里改 PATH，
非交互 shell 读不到，远端明明装了 node 却报 `command not found`。

文件读写刻意不走登录 shell：profile 里任何一句 echo 都会混进 stdout，把文件内容污染成
「前面多了一行欢迎语」。读写直接走 `ssh -T` 的 8-bit clean 原始字节流，也因此不需要
base64（GNU 的 `-d` 与 BSD 的 `-D` 不兼容）。

### 传输选系统 OpenSSH

`~/.ssh/config` 的 Include、Match、ProxyJump、ProxyCommand、IdentityAgent、FIDO 安全
密钥、GSSAPI 全部由它原生支持。用户只要 `ssh host` 能连上，Vetta 就能连上。

`StrictHostKeyChecking` 保持 OpenSSH 默认的 `ask`：首次连接和主机密钥变更必须由用户
确认，`no` 会让中间人攻击静默通过，`accept-new` 则跳过首次确认。

## 测试

命令引用、URI 往返和失败分类是本包的核心风险，各有定向测试。使用仓库统一入口：

```bash
bun scripts/flowstoken/test-ssh-platform.mjs
```

`SshProcessRunner` 是可注入端口，因此以上全部可以在没有 SSH 服务器的情况下验证。

发布平台矩阵核对完整文件清单：新测试未分类、文件缺失、未知平台均失败，不通过 skip 隐藏
客户端停止问题。纯合同与 native Node 进程树测试全平台运行；真正的 POSIX 端点不拿
Windows PID 或 NTFS 权限来假装验证。macOS/Linux 还运行原生 Go server/PTY 测试，缺 Go 时门禁失败。

| 文件 | 平台 | 合同 |
| --- | --- | --- |
| `askpass.test.ts` | 全部 | 提示分类、凭据记忆与环境构造 |
| `directory-listing.test.ts` | 全部 | 字节/目录列表解析 |
| `node-process-runner.test.ts` | 全部 | 原生 Node 输出、孙进程取消/超时、双向通道与真实 close |
| `project-uri.test.ts` | 全部 | URI 与项目身份 |
| `remote-command.test.ts` | 全部 | 命令引用、构造与参数保护 |
| `remote-listeners.test.ts` | 全部 | 端口/进程解析、选择与参数保护 |
| `remote-pty.test.ts` | 全部 | PTY 命令和 SSH channel 适配合同，不声称原生 PTY 验收 |
| `ssh-config-aliases.test.ts` | 全部 | OpenSSH 别名解析 |
| `ssh-connection.test.ts` | 全部 | 连接、取消、错误与 helper 协议合同 |
| `remote-command.posix.test.ts` | macOS/Linux | 原生 shell、PGID、stat、权限和符号链接 |
| `remote-command-signals.test.ts` | macOS/Linux | 原生 TERM/KILL、PGID 与 PID 防护 |
| `remote-listeners.posix.test.ts` | macOS/Linux | 原生 ps、TERM/KILL 和真实 close |
| `ssh-connection.loopback.test.ts` | macOS/Linux | POSIX 文件/权限/端口与原生 Go helper |
| `helper.e2e.test.ts` | macOS/Linux | 真实 Go 二进制上传、握手、条件写、接管与通知 |

Windows 额外明确执行 Desktop 的 `loopback-fixture`、`command-spawner.remote`、
`remote-command-runner`、`resource-runtime.remote` 与 `filesystem-service.remote-flow` 五套
Git Bash 流程；停止、端口实际撤销/再绑定/再用、参数引用、文件操作与资源隔离必须通过。

POSIX 主机的真实 `/bin/sh`、进程组 TERM/KILL 与 PID 保护由 macOS/Linux 测试验证；
本地 OpenSSH/ProxyCommand 的取消和通道关闭由 `node-process-runner.test.ts` 验证：
POSIX 使用独立进程组，Windows 对自己持有的 live 原生 PID 使用 `taskkill /T`。
Windows 测试夹具用 Git Bash 表达远端 POSIX 命令。可取消操作默认先把等待 IPC 的独立
Node 父进程加入专用 Windows Job，再启动 Bash；Job 禁止 breakaway，并在关闭时回收
它拥有的进程。停止必须同时经过真实管道关闭和 Job 内进程数归零，才能执行排队请求；
多层 shell 回归还以保留的原生句柄验证两个固定身份的子进程退出。此边界不需要 CI 环境
开关，保留原来的 5 秒测试要求及排队期间的取消、超时和终止错误。只读资源发现直接启动
真实 shell，避免每个 stat/read 再增加 Node 父进程。原生 Win32 调用通过测试依赖 Koffi
加载；缺库、身份不匹配、分配失败或 Job 未清空都会让门禁失败。

Desktop 的插件端口分配、停止及再次执行，以及远程资源发现共同验证这条跨包接线。
在 `apps/desktop` 中运行以下命令；这些测试不使用真实 SSH 主机或用户状态目录：

```bash
bun ../../scripts/quality/run-vitest.mjs --run src/main/ssh/loopback-fixture.test.ts src/main/plugins/command-spawner.remote.test.ts src/main/agent-runtime/resource-runtime.remote.test.ts
```
