# Spec: workspace 切换菜单的搜索与最近使用排序

空态 composer 的 workspace 切换菜单（`ChatEmptyWorkspacePreviewMenu`，`packages/ui/src/ChatEmptyState.tsx`）供用户从已打开的 workspace 中选择要切换到的目标。Automations、OffPeak 等视图复用同一菜单。本 spec 约束该菜单的搜索匹配规则、列表排序，以及排序所依赖的「上次激活时间」的所有权与持久化。

## 范围（Scope）

- 适用于 `ChatEmptyWorkspacePreviewMenu` 的 workspace 列表区；底部固定动作（打开文件夹、从空目录开始、远程连接、不在项目中工作）不参与搜索和排序。
- 侧栏的手动排序不受影响，仍是用户拖拽后的顺序。
- `recentProjects` 不在本 spec 范围：它只在用户手动打开项目时更新，同时被 Memory Scope 顺序和启动工作区解析使用，不能当作「上次使用」事实源。

## 产品规则

### 搜索匹配

- 查询词 trim 并转为小写后匹配，大小写不敏感。
- 查询词不含 `/`、`\` 或盘符（如 `C:`）时，只匹配 workspace 的显示名称：标题（目录名或主目录标签）与 `label`。
- 查询词含 `/`、`\` 或盘符时，额外匹配完整路径和远程目标描述。
- 不再无条件把完整路径拼入搜索文本。之前 `C:\Users\<name>\...` 这类路径里的 `Users` 会让单个常见字母命中全部项目，菜单最多显示 5 条，表现为搜索无反应。

### 排序

- 列表按上次激活时间从新到旧排列，然后才截取前 5 条。
- 没有激活时间的 workspace 排在最后，彼此保持传入顺序。
- 激活时间相同的 workspace 保持传入顺序。

## 状态所有权

- 「上次激活时间」的唯一所有者是窗口的 tab store（`packages/ui/src/store/tabStore.ts`，字段 `WorkspaceTabState.lastActivatedAt`）。菜单只读取，不自行记录。
- 激活时间只在以下时机由 tab store 写入，其它代码不得直接修改该字段：
  1. `addTab` 新建或复用 tab 并使其成为激活 tab 时，写入该 tab。
  2. `activateTab` 激活一个 workspace tab，且它不是当前激活 tab 时，写入该 tab。
  3. `activateTabByPath` 激活一个不是当前激活 tab 的 tab 时，写入该 tab。
  4. `closeTab` 关闭当前激活 tab 并由相邻 workspace tab 接替时，写入接替的 tab。
  5. `restoreTabs` 恢复时：各 tab 读取持久化的激活时间，本次被激活的 tab 写入当前时间。
- `ensureWorkspaceTab` 不改激活状态，不写入激活时间。
- 同一窗口内写入的时间严格递增：取 `max(Date.now(), 上一次写入值 + 1)`，避免同一毫秒内连续切换造成顺序不稳定。
- 打开「设置」「文件」主视图不改变最近激活的 workspace，不写入激活时间。

## 持久化与恢复

- 激活时间随 `lastWorkspaceSession` 持久化，不新增设置项，不新增第二条写入路径。
  - 本地条目：`LocalWorkspaceSessionEntry.lastActivatedAt?: number`。
  - 远程条目：`RemoteWorkspaceSessionEntry.lastActivatedAt?: number`。`lastOpenedAt` 语义不变，仍表示最近一次成功打开远程 workspace 的时间。
- `buildPersistedWorkspaceSessionEntries` 写出 tab 的激活时间。
- 恢复时 `restorePersistedRemoteWorkspaceSessions` 与 `useTabPersistence` 默认恢复流程把条目的激活时间透传给 `restoreTabs` / `completeTabRestore`。
- `completeTabRestore` 合并已有 tab 时保留两者中较新的激活时间；不改变当前激活 tab。
- 旧设置缺少该字段时按「从未激活」处理，菜单退回传入顺序；用户下次切换 workspace 后即建立顺序。

## 事件顺序

```text
用户切换 workspace
  └─ tabStore.activateTab / activateTabByPath / addTab     # 唯一写入点
       └─ tabs[i].lastActivatedAt = max(now, prev + 1)
            └─ useTabPersistence 订阅（debounce 300ms）
                 └─ buildPersistedWorkspaceSessionEntries    # 派生，不持有状态
                      └─ settingService.update({ lastWorkspaceSession })

下次启动
  └─ settingService.get()
       └─ restorePersistedRemoteWorkspaceSessions
            └─ restoreTabs / completeTabRestore             # 透传 lastActivatedAt
                 └─ 菜单 useMemo 读取 tabs → 按激活时间降序 → 截取前 5 条
```

## 接口

- `ChatEmptyWorkspaceMenuTab.lastActivatedAt?: number`：可选，由调用方从 tab 透传；缺省表示从未激活。
- `filterVisibleWorkspaceMenuTabs`（导出，供测试）：`workspaceTabs × homeWorkspaceLabel × searchQuery → 过滤并排序后的列表`。

## 验收场景

1. 路径均在 `C:\Users\<name>\Documents\GitHub\` 下的多个项目，输入 `r`：只显示名称含 `r` 的项目。
2. 输入 `music`：显示 MusicFree 与 MusicFreePlugins。
3. 输入 `zzz`：显示「没有匹配的工作区」。
4. 输入 `GitHub\pog`：命中路径包含该片段的项目。
5. 没有搜索词时，最近激活的 workspace 排在第一位。
6. 从未激活过的 workspace（无激活时间）排在最后。
7. 激活已在激活的 tab：不更新激活时间。
8. `ensureWorkspaceTab` 补建 tab：激活时间不变。
9. 关闭当前激活 tab 后，接替的 tab 成为最近激活。
10. 设置校验：条目带 `lastActivatedAt` 时保留该字段；缺少时通过校验。
11. 持久化再恢复后，各 workspace 的激活时间与恢复前一致，菜单顺序不变。
