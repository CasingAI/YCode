# Spec: 插件能力导航收敛（移除边栏 MCP 独立入口）

## 目标

设置页左侧边栏 `Agent 能力`分组下同时存在「插件」聚合入口和「MCP 服务器」独立入口，
右侧插件页内又有「插件 / MCP / 技能」三个页签。两个 MCP 入口渲染同一个
`PluginsSection(mode="mcp" | 缺省) + McpSettingsSection`、同一份 store 数据，
属于冗余导航。本 spec 把导航收敛为单一入口：只保留「插件」聚合页，
边栏不再展示独立 MCP 项。

## 产品规则

- 边栏 `Agent 能力`分组保留「插件 / 技能 / 命令 / 钩子」等独立项，
  删除其中的「MCP 服务器」独立项（`settingsPageConfig.ts` 不再注册 `id: "mcp"`）。
- MCP 管理只保留插件页内的 MCP 页签（`settings.plugin.tab.mcps`），
  与插件列表、技能页签共享同一 Scope 选择器、搜索框与计数逻辑。
- 所有原来指向独立 MCP 分区的深链（quickpick「MCP 服务器」、
  `setPendingSettingsPluginIntent("mcps")` 等）一律收敛为
  「打开插件分区 + 选中 MCP 页签」，不得再产生 `activeSection === "mcp"`。
- 设置页 (`SettingsPage`) 不再渲染 `mode="mcp"` 的 `PluginsSection` 分支。
  `PluginsSection` 的 `mode` 类型保留 `"mcp"` 以兼容残留调用，
  但内部把 `mode="mcp"` 视为与 `mode="plugin"` 等价的聚合视图，
  `initialTab` 未指定时默认选中 MCP 页签（承接旧深链语义）。

### 状态所有者与接口

- 导航意图唯一所有者仍是 `packages/ui/src/lib/settingsNavigation.ts`：
  `setPendingSettingsPluginIntent("mcps")` 写入的 section 由 `"mcp"` 改为 `"plugin"`，
  并附带 `pluginTab: "mcps"`，由 `SettingsPage` 消费后选中插件页内 MCP 页签。
- `resolveSettingsSection` 把历史 `"mcp"` 值迁移为 `"plugin"`（与已有 `"plugins"` 迁移一致），
  `readLastSettingsSectionPreference` 把本地持久化的旧 `"mcp"` 改写为 `"plugin"`
  并补写 `pluginTab: "mcps"`，避免老用户停留在不存在的分区。
- `SettingsSectionId` 类型保留 `"mcp"` 字面量，仅用于兼容历史持久化/事件载荷的解析，
  不再作为可见分区出现。

## 事件顺序

```text
spec 落定
  → settingsNavigation 收敛深链（mcps → plugin+mcps tab，mcp → plugin 迁移）
  → settingsPageConfig 删除 mcp 独立项
  → SettingsPage 删除 mode="mcp" 分支 + 已打开页监听兼容旧意图
  → PluginsSection mode="mcp" 等价聚合视图（默认选中 mcps）
  → quickpick/App 调用方回归（行为不变，只是落点从独立页变为聚合页 tab）
  → 单测锁定：边栏无 mcp、深链落点、历史迁移
```

## 负面边界

- 不改 MCP 本体功能：`McpSettingsSection`、自建 servers、插件贡献 MCP 分组、
  Scope、搜索、计数、OAuth 入口一律不动。
- 不动边栏「技能 / 命令 / 钩子」独立项：本次只收敛 MCP，
  技能与命令的独立入口是否收敛另议。
- 不删除 i18n `settings.mcpTitle`：历史事件/日志可能仍引用，保留文案仅不再挂载到边栏。
- 不为手机远控、relay、Host attachment 引入新路由：仍复用现有设置页覆盖层。
- 不用 CDP 操作 YCode。

## 验收场景

1. 打开设置页，左侧 `Agent 能力`分组没有「MCP 服务器」一项；点击「插件」进入聚合页，
   顶部有「插件 / MCP / 技能」三个可切换页签。
2. 在命令面板/quickpick 搜索 MCP 并执行，打开的是插件页且自动选中 MCP 页签，
   scope 与搜索行为与之前独立页一致。
3. 本地存过 `zcode-settings-last-section = "mcp"` 的老用户再次打开设置页，
   落到插件页的 MCP 页签，而不是空白或回退到通用页。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；
   新增 `packages/ui/test/pluginCapabilityNavigation.test.ts` 通过。
