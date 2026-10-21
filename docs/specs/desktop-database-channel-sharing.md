# Spec: 渠道隔离根只隔离非数据库数据（数据库固定共享）

## 目标

Windows 与 macOS 行为一致：ZCode、YCode Preview、YCode Dev 三个渠道**共用同一份任务
索引库**，侧边栏历史、置顶、归档、分组、搜索完全一致；渠道隔离只作用于凭据、证书、
日志、provider 配置、插件缓存、CLI Proxy 等非数据库数据。

## 症状与根因

- 症状：同一台机器上，Dev 渠道的侧边栏历史与官方 ZCode 不一致（表现为空或只有 Dev
  自己新建的会话）。
- 根因：桌面端侧边栏历史只读 `tasks-index.sqlite`（`packages/services/src/paths.ts`
  的 `getTasksIndexDatabasePath`），而该路径此前跟随渠道隔离根
  `ZCODE_DATA_BASE_DIR`。`mise dev` / `mise start` 会注入
  `ZCODE_DATA_BASE_DIR=<dev home>/.zcode-dev-home`，于是 Dev 打开的是**另一个索引
  文件**，与官方 ZCode 所在的库无关。
- 加剧因素：CLI 会话库 `~/.zcode/cli/db/db.sqlite` 天然共享（CLI 侧把 `~` 展开为
  `os.homedir()`，不看隔离根），但桌面端侧边栏**从不读它**，它只经 per-workspace 的
  `sessions-index` 懒回填进任务索引库。所以"共享 CLI 库"既不是缺的那一环，也不会
  自动带来历史。
- 平台差异来源：macOS 上用户比较的是"已安装渠道 vs 已安装渠道"，都在真实 home 下，
  因此没有分叉；Windows 上从源码跑 Dev，隔离根生效，索引就分叉了。

## 产品规则

1. **渠道隔离根只隔离非数据库数据。** 凭据、证书、日志、provider 个人配置、插件
   缓存、skills、workflows、CLI Proxy 目录、git-checkpoint 索引、会话快照等继续跟随
   隔离根。
2. **数据库固定共享。** 共享模式下，任务索引库及其 WAL/SHM/journal 文件固定落在
   `os.homedir()/.zcode/v2/`，与官方 ZCode、CLI 会话库同址；不跟随渠道隔离根，也不
   跟随用户自定义 `dataBaseDir`。
3. **独立数据库模式完全隔离。** `useIndependentDatabase` / `YCODE_INDEPENDENT_DATABASE`
   开启时，任务索引库落在 `<dataBaseDir>/.ycode/v2/tasks-index.sqlite`，CLI 会话库
   落在 `<home>/.ycode/cli/db/db.sqlite`，与共享模式互不可见；本 spec 不改变该模式。
4. **默认工作区目录共享。** 非项目会话的工作目录 `<home>/.zcode/workspace/default`
   是共享会话库里的**寻址键**：若它跟随隔离根，同一份共享库里会出现两条 default
   谱系，Windows 上侧边栏会多出一个"默认工作区"分组，与 macOS 不一致。该目录是空的
   暂存目录（会话 cwd），共享它不泄露任何凭据。
5. **Windows home 口径唯一。** 真实主目录一律取 `os.homedir()`：Windows 的 `HOME`
   可能是 MSYS 风格（`/c/Users/<name>`），拼出的路径会落到 `C:\c\Users\<name>` 这种
   错位目录；POSIX 上 `os.homedir()` 即 `$HOME`，行为不变。

## 所有者与时序

```text
启动
  → 读渠道隔离根（env ZCODE_DATA_BASE_DIR，用户显式 dataBaseDir 兜底）
  → 非数据库数据根 = 隔离根（凭据、日志、配置、缓存、CLI Proxy…）
  → 数据库根 = os.homedir()/.zcode/v2（任务索引、automation、off-peak）
  → 默认工作区 = os.homedir()/.zcode/workspace/default（非项目会话 cwd）
  → CLI 会话库 = os.homedir()/.zcode/cli/db/db.sqlite（CLI 侧展开 "~"）
  → 侧边栏只读任务索引库；CLI 库经 sessions-index 首帧懒回填进索引
```

- 任务索引库的唯一 owner：`packages/services/src/paths.ts` 的路径解析；
  写入方是 `taskIndexRepo` / `automationRepo` / `offPeakTaskRepo`。
- 不新增跨渠道列举协议、不新增回填链路、不改侧边栏作用域解析：共享同一份库后，
  各渠道读到的就是同一批行。

## 明确不做

- 不做跨渠道数据回填、复制或同步；共享靠**同一个文件**，不靠搬运数据。
- 不改 `packages/shared/src/zcode-protocol/*`；协议与可见性无关。
- 不改 UI 侧边栏作用域解析、投影与分片逻辑。
- 不动独立数据库模式的语义与路径。

## 风险与迁移

- 已经用隔离根写过一份任务索引库的渠道，修复后会自动改读共享库；隔离根下那份
  旧库**不删除、不迁移**，留在原地（用户可自行清理）。
- `copyDataDirectory`（用户改数据根时的搬迁）不再复制任务索引库文件，避免在新
  数据根下留一份永远不被读取的副本。
- 共享模式下多个渠道会同时打开同一个 SQLite 库，沿用既有 WAL 行为，不新增锁策略。

## 验收场景

1. `ZCODE_DATA_BASE_DIR` 指向隔离根时，`getTasksIndexDatabasePath()` 仍等于
   `os.homedir()/.zcode/v2/tasks-index.sqlite`；`getAppConfigDir()` 仍跟随隔离根。
2. 隔离根下默认工作区目录等于 `os.homedir()/.zcode/workspace/default`。
3. 独立数据库模式下，任务索引库仍等于 `<dataBaseDir>/.ycode/v2/tasks-index.sqlite`。
4. `HOME` 为 MSYS 风格（`/c/Users/<name>`）时，路径解析不落到 `C:\c\Users\<name>`。
