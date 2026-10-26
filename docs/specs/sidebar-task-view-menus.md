# Spec: 任务侧栏的独立视图与排序菜单

## 目标

任务侧栏原来用一个「分组 / 项目」分段切换器决定一级视图，另用一个合并下拉同时承载「视图」（项目 / 时间线）和「排序方式」。入口分散且不对称：分组视图下连排序都看不到，用户也无法从分组视图理解自己还能切到时间线。

本 spec 把两个维度拆成两个独立下拉：

- 左侧「视图」菜单取代旧分段切换器，固定三项：**分组 / 项目 / 时间线**。
- 右侧「排序方式」菜单只负责更新时间 / 创建时间。

两个菜单共享既有 `taskOrganizeBy` / `taskSortBy` 状态与持久化，不新增业务状态。

## 产品规则

### 视图菜单

- 位置：原「分组 / 项目」分段切换器的位置（工具栏左侧）。
- 触发器：当前视图的图标 + 当前视图文案 + `ChevronDown`；可访问名称与 tooltip 均为「视图」（`workspaceSidebar.organize`）。
- 菜单项顺序固定为：分组、项目、时间线。
- 菜单标题为「视图」（`workspaceSidebar.organize`）。
- 文案使用既有 key：
  - 分组：`workspaceSidebar.organizeGrouped`
  - 项目：`workspaceSidebar.organizeByProject`（不是「按项目」）
  - 时间线：`workspaceSidebar.organizeChronologicalList`
- 当前视图以 `DropdownMenuRadioGroup` 的选中态表达，选中项右侧显示勾。
- 视图菜单在非归档视图始终可见，包括分组视图；否则用户无法从分组切出。
- 归档视图隐藏视图菜单。归档是独立列表模式，不允许在归档时通过视图菜单隐式切走。

### 排序菜单

- 位置：原合并下拉的筛选图标位置（工具栏右侧），使用独立 `DropdownMenu`。
- 触发器：排序图标（`ArrowUpDown`），可访问名称与 tooltip 均为「排序方式」（`workspaceSidebar.sortBy`）。
- 菜单项顺序保持：更新时间、创建时间；使用 `DropdownMenuRadioGroup`，选中项打勾。
- 分组视图不显示排序菜单。分组列表不使用 `taskSortBy`，保持改动前的语义；置顶区仍按已持久化的 `taskSortBy` 排序，不因菜单隐藏而改变。
- 项目、时间线和归档视图显示排序菜单。

### 归档覆盖

- `showArchivedTasks` 仍优先级最高，派生 `taskViewMode = "archived"`。
- 归档视图：隐藏置顶区、隐藏视图菜单、保留排序菜单。
- 退出归档后，视图恢复为归档前的 `taskOrganizeBy`。

### 兼容

- 持久化 schema 不变：仍为 `zcode-sidebar-task-preferences` 的 `{ organizeBy, sortBy }`。
- `organizeBy` 继续只接受 `grouped | project | chronological`，`sortBy` 继续只接受 `created | updated`。
- 旧用户已保存的分组 / 项目 / 时间线选择直接生效，不需要迁移。
- 桌面端与手机 Web 共用同一套 `WorkspaceSidebar` UI；本次不新增协议、RPC、Host 或远端同步。

## 状态所有者

| 状态            | 所有者                                    | 说明                                                                                  |
| --------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| 当前一级视图    | `WorkspaceSidebar` 的 `taskOrganizeBy`    | 初值来自 `readSidebarTaskPreferences().organizeBy`；变更后由 effect 写回 localStorage |
| 当前排序        | `WorkspaceSidebar` 的 `taskSortBy`        | 初值来自 `readSidebarTaskPreferences().sortBy`；同一 effect 写回                      |
| 归档开关        | `WorkspaceSidebar` 的 `showArchivedTasks` | 本地 UI 状态；解析视图时优先于 `taskOrganizeBy`                                       |
| 菜单开合 / 高亮 | Radix `DropdownMenu` 内部状态             | 不进入 zcode store，不持久化                                                          |
| 分组展开偏好    | 既有 `groupedTaskExpansionPreference`     | 本次不改                                                                              |

`taskOrganizeBy` 是从「视图」菜单到列表装配的唯一事实来源；`taskSortBy` 是排序的唯一事实来源。两个菜单只发送选择值，不各自复制状态。

### 视图映射

| 菜单项 | `taskOrganizeBy` | `taskViewMode` | 列表                            |
| ------ | ---------------- | -------------- | ------------------------------- |
| 分组   | `grouped`        | `grouped`      | `WorkspaceGroupedTasksSection`  |
| 项目   | `project`        | `workspace`    | 项目 / 任务分区树               |
| 时间线 | `chronological`  | `timeline`     | `WorkspaceTimelineTasksSection` |

归档开关为 true 时，以上映射统一覆盖为 `archived`。

## 事件顺序

```
用户点「视图」触发器
  └─ Radix 打开菜单（内部状态，不落盘）
       └─ 选择「分组 / 项目 / 时间线」
            └─ RadioGroup.onValueChange(value)
                 ├─ value === "grouped" → setGroupedTaskGroupIdsHydrated(false)
                 │    （防止分组首帧空快照 prune 用户收起偏好）
                 ├─ setTaskOrganizeBy(value)
                 │    └─ 派生 taskViewMode → 装配对应列表
                 └─ persistSidebarTaskPreferences({ organizeBy, sortBy })
                      └─ localStorage: zcode-sidebar-task-preferences

用户点「排序方式」触发器
  └─ 选择「更新时间 / 创建时间」
       └─ setTaskSortBy(value)
            ├─ 置顶区 / 项目列表 / 时间线 / 归档列表读取新排序
            └─ persistSidebarTaskPreferences({ organizeBy, sortBy })
```

菜单本身不写持久化；持久化仍由 `WorkspaceSidebar` 的既有 effect 统一完成，避免出现第二条写入路径。

```
┌──────────────────────────── UI ────────────────────────────┐
│ 视图菜单 ──taskOrganizeBy──┐                              │
│ 排序菜单 ──taskSortBy──────┤                              │
└────────────────────────────┼──────────────────────────────┘
                             ▼
                 WorkspaceSidebar (唯一 owner)
                             │  effect
                             ▼
              zcode-sidebar-task-preferences
              { organizeBy, sortBy }  (本机 localStorage)
```

## 负面边界

- 不新增 `sortBy` 可选值，不扩展排序器、查询参数或 sqlite 排序。
- 不把视图或排序改成远端 / 账户级偏好；不做跨设备同步。
- 不在菜单组件里维护第二份选中状态。
- 不删除归档与置顶的既有成员关系规则。
- 不改变分组列表内部的组排序与拖拽规则。
- 不恢复分段切换器，也不保留隐藏在「项目 / 时间线」二选一里的旧交互。
- 不改 `WorkspaceSidebarMoreMenu`、底栏主视图或文件视图。

## 验收场景

### 自动化

1. 菜单静态渲染：视图触发器输出可访问名称「视图」、当前视图文案、`aria-haspopup="menu"`；排序触发器输出可访问名称「排序方式」。
2. 视图菜单内容按「分组 / 项目 / 时间线」顺序渲染三项，选择任一项回调携带对应值。
3. 排序菜单内容按「更新时间 / 创建时间」顺序渲染两项，选择任一项回调携带对应值。
4. 既有 `resolveSidebarTaskViewMode` 单测继续覆盖 grouped / workspace / timeline / archived 与置顶区规则。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

### E2E / 人工

1. 侧栏左侧只剩一个「视图」下拉，右侧只剩一个排序图标；旧分段切换器消失。
2. 打开视图菜单看到三项且当前项打勾；依次选择三项，列表分别切换为分组列表、项目分区列表、时间线列表。
3. 从分组视图选择「项目」或「时间线」可以切出；切回分组后，此前收起的组仍保持收起。
4. 打开排序菜单选择「创建时间」，置顶区、项目列表、时间线、归档列表按创建时间排序；刷新应用后仍保持。
5. 分组视图下看不到排序菜单；项目 / 时间线 / 归档视图下排序菜单可用。
6. 进入归档视图：置顶区消失、视图菜单消失、排序菜单仍在；退出归档后回到进入前的视图。
7. 桌面端与手机 Web 行为一致；窄屏抽屉内两个菜单都能完整打开且不被视口裁剪。
8. 中英文切换后触发器与菜单文案正确，无折行或溢出。
