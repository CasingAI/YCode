# Spec: Desktop 数据身份与官方 ZCode 分离（userData）

## 目标

让 YCode 的 Electron userData 指向独立目录 `%APPDATA%\YCode`，从而与官方 ZCode 各自持有自己的单实例锁：官方 ZCode 正在运行时，YCode 仍能正常启动，不再被抢占锁后直接退出。

## 现状与根因

单实例锁绑定在 Electron 的 userData 路径上（`packages/desktop/src/main/index.ts:1835` 的 `app.requestSingleInstanceLock()`）。而 userData 被显式设为 `%APPDATA%\<runtimeApplicationName>`（`desktopRuntimeEnv.ts:78` 的 `runtimeUserDataPath`），`runtimeApplicationName` 当时仍是历史值 `ZCode`。

于是官方 ZCode 与本仓库构建的 YCode 指向同一个 `%APPDATA%\ZCode`：先启动的持有锁，后启动的 `requestSingleInstanceLock()` 返回 false 并立即 `app.quit()`，同时把 `second-instance` 事件发给已运行的实例，表现为"窗口被聚焦的是 ZCode"。

此前"显示身份与数据身份解耦"的设计（`runtimeApplicationDisplayName` 显示 YCode、`runtimeApplicationName` 保留 ZCode 作为数据身份）是为了让改名不打断老用户数据。该解耦在 YCode 作为独立产品发布的前提下不再成立，反而造成"界面 YCode、系统 ZCode"的割裂。

## 产品规则

- 应用名只有一个来源：`runtimeApplicationName`。它同时是 userData 目录名、`app.setName()` 的取值、`process.title`、Linux `StartupWMClass` 与 ARMS 上报名。
- 取值：开发态 `YCode Dev`、Preview 包 `YCode Preview`、正式包 `YCode`。
- `ZCODE_DESKTOP_APPLICATION_NAME` 仍是测试用的显式覆盖入口，语义不变（e2e 需要隔离身份以免被本机正式版抢占单实例锁）。
- userData 目录随应用名变为 `%APPDATA%\YCode`，与官方 ZCode 的 `%APPDATA%\ZCode` 互不影响。

## 状态所有者与接口

```text
desktopRuntimeEnv.ts（唯一 owner）
  runtimeApplicationName = "YCode" | "YCode Dev" | "YCode Preview"
    ├─ runtimeUserDataPath        → app.setPath("userData", …)   ← 单实例锁随之独立
    ├─ runtimeSessionDataPath     → app.setPath("sessionData", …)
    ├─ app.setName() / process.title
    ├─ Linux deep-link productName（StartupWMClass）
    └─ ARMS 上报 name
```

`runtimeApplicationDisplayName` 被删除：它与 `runtimeApplicationName` 取值相同，属于同一概念的第二处事实来源。所有调用点统一到 `runtimeApplicationName`。

## 负面边界

本次明确不改：

- **业务数据根 `~/.zcode` 不动**。凭据（`~/.zcode/v2`）、会话、工作区、插件目录仍由 `packages/services/src/paths.ts` 的 `getZCodeDataRootDir()` 解析，仍与官方 ZCode 共用同一份。这是本次刻意接受的代价，不是遗漏。
- 不改 `ZCODE_HOME`、`ZCODE_DATA_BASE_DIR`、`ZCODE_*` 环境变量、`@zcode/*` 包名、深链 scheme。
- 不做旧数据迁移：`%APPDATA%\ZCode` 保持原样留给官方 ZCode，YCode 首次启动使用全新的 `%APPDATA%\YCode`。窗口状态、remote-assets 缓存等会重新生成。
- `mcpUserDirectory/legacy.ts` 已把 `%APPDATA%\ZCode` 列为 legacy 来源，common MCP 配置会照旧自动迁移，不新增迁移逻辑。
- 不改 `ZCODE_DESKTOP_USER_DATA_DIR` / `ZCODE_DESKTOP_SESSION_DATA_DIR` 覆盖入口的行为。
- 不改安装器逻辑（`.zcode` 数据目录阻断页仍按 `.zcode` 判定）。
- 禁止全局搜索替换。

## 风险

- **共用 `~/.zcode` 是本次最大的已知风险**：两个进程会同时读写同一份凭据、会话索引与工作区。并发写入可能导致配置互相覆盖或索引损坏，且损坏会同时影响官方 ZCode。本次按用户明确选择接受该风险；彻底隔离需要把业务数据根也分离，属于后续独立改动。
- 首次启动为全新 profile：需要重新登录，窗口尺寸/位置与 remote-assets 缓存重新生成。`%APPDATA%\ZCode` 中数据不被删除，官方 ZCode 不受影响。
- 应用名变化会让 Linux `StartupWMClass` 从 `ZCode` 变为 `YCode`，已存在的 `.desktop` 窗口匹配关系需要重新建立。

## 验收场景

1. 官方 ZCode 正在运行时启动 YCode：YCode 正常出现自己的窗口，不再退出，也不聚焦 ZCode 的窗口。
2. 反向：YCode 正在运行时启动官方 ZCode，官方 ZCode 正常启动，两者并存。
3. `app.getPath("userData")` 为 `%APPDATA%\YCode`；`%APPDATA%\ZCode` 内容不被修改或删除。
4. 关于面板、任务管理器进程名、窗口标题仍显示 YCode（应用名变化不引入回退）。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
