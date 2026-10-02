# 分组与模型目录的日常维护

0.6.4 的日常展示数据从服务端同步。官网首页和客户端读取同份 schema 2 目录，客户端用账户实际权限和经过验证的凭据接入，目录本身不授予权限或修改计费。

| 变更 | 维护入口 | 需要客户端发版 |
| --- | --- | --- |
| 增删已有协议支持的模型、调整所属计费组 | NewAPI 模型与分组配置 | 否 |
| 分组名称、双语名称、显示顺序、推荐模型 | desktop-catalog-overrides.json 的 groups 数组 | 否 |
| 厂家名称、Logo、排序、模型显示名与隐藏项 | NewAPI 厂家数据、展示配置及 vendor-icons 资源 | 否 |
| 已支持的用途、上下文/输出上限、推理档位 | 经核实的模型 metadata 或展示覆盖配置 | 否 |
| 价格、配额和账户分组权限 | NewAPI 对应管理配置 | 否 |
| 新执行协议、新工具、全新用途的调用功能或界面能力 | 客户端源码及兼容性验证 | 是 |

## 分组身份

`id` 是不可变的 NewAPI 计费 key。改名使用 `title` 和 `titles.zh/en`，不要通过修改 `id` 改显示名称。`smart/default/vip` 对应固定 Provider，其余组由 ID 派生 Provider；大小写保留。新增组须先在 NewAPI 配好实际模型和权限，再加入目录。

`groups` 是完整、有序数组。删除一项即从 v2 展示目录移除；`[]` 明确清空目录。推荐模型必须确实属于同组。服务端改推荐项不会自动替换已有会话的模型选择或收费组。

## 同步路径

服务器配置为 `/opt/flowstoken-deploy/desktop-catalog-overrides.json`，可选能力 metadata 为 `/var/www/flowstoken/brand/model-meta.json`。生成器读取公开 `/api/pricing`，每分钟验证并发布完整目录。它不修改价格、API 端点、用户令牌或路由。

新客户端使用 `/brand/desktop-catalog-v2.json`；旧 `/brand/desktop-catalog.json` 保留三组兼容投影。两份文件写进不可变 revision 后，一次切换公共指针。JSON 使用可重验证缓存，客户端每分钟检查，也可在菜单中手动刷新。

不知道的能力数值应省略，不按型号猜上限。`kind` 仅支持 chat/image/embedding/rerank/audio/video；推理档位仅支持已编译的 none/minimal/low/medium/high/xhigh/max，空数组可明确撤销档位。目录不会执行下发代码。

## 发布前检查

在服务器运行生成器的 `--dry-run --no-notify`，确认模型属于正确分组、推荐项存在、两种 schema 校验通过，再发布。核对两个公开 URL 的 HTTP 状态与 revision，并在官网和客户端检查标题、顺序、厂家 Logo、模型搜索和下架状态。

下架模型的历史记录和已保存选择会保留，界面提示当前不可用；用户须明确选择新的模型。个人 Provider 和显式参数不会因展示目录更新被重置。

## 回滚

完整备份包含生成器、支持模块、配置、旧目录、隐藏 revision 目录及网站展示脚本。只执行 `--rollback last-known --no-notify` 会切回一份目录快照；若输入配置仍是新版本，下次定时生成会重新发布它。

持久回滚须同时恢复相应配置和必要源码，协调一分钟 timer 与旧的两小时调用，再验证生成器和公开 URL。不要删除 `.desktop-catalog` 中的历史快照。客户端接受内容合法的旧 revision，以便真正恢复。

官网这轮同源接线覆盖首页模型价格目录。营销文案、公告等仍需单独维护，不能因为目录已同步就认定全站文案自动更新。
