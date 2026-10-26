# Spec: 侧栏任务分页时的数据与滚动稳定

## 目标

侧栏时间线底部的「显示更多」，以及归档视图的「显示更多 / 显示更少」，只改变当前已读窗口，不得在等待新窗口数据时清空已经展示的任务行或退回加载提示。显示更多时不得让内容临时收缩导致侧栏滚动位置回到顶部；主动收起时内容变短，允许浏览器按现状把 `scrollTop` 夹到新的最大值。

## 现象与根因

- `WorkspaceTimelineTasksSection.tsx` 用本地 `visibleTaskLimit` 表示时间线分页窗口，点「显示更多」时执行 `setVisibleTaskLimit((current) => current + 20)`，并把该值作为 `collapsedLimit` 传给 `useGlobalTaskList`。
- `useGlobalTaskList` 把 `limit` 和其他查询条件一起写进 `queryKey`。数据只有一份 `items`，展示条件是 `dataQueryKey === queryKey`（另加 workspace scope 门控）。
- 因此 `limit` 一变，展示条件立即不成立：`items` 返回空数组、`total` 返回 0、`hasMore` 返回 false，直到新一页请求成功。
- 时间线在 `items.length === 0 && loading` 时只渲染 `TaskListLoadingHint`，整段列表 DOM 被替换成一行提示。滚动容器内容高度骤减，浏览器把 `scrollTop` 夹回顶部，表现为「点显示更多会回顶」。
- 归档视图的 `expanded` 把 `limit` 从 20 改成 `undefined`，收起时再改回 20，走的是同一条清空/回顶路径。

分页窗口变化不是查询语义变化。展示身份没有变化时，上一页结果仍然属于同一结果集的可信前缀，应该在等待下一页期间继续展示。

## 产品规则

### 唯一 owner

- 分页窗口：时间线由 `WorkspaceTimelineTasksSection` 的 `visibleTaskLimit` 唯一持有；归档视图由 `WorkspaceArchivedTasksFlatSection` 的 `showAllTasks` 唯一持有。它们只负责把窗口大小传给 hook。
- 查询结果：`useGlobalTaskList` 唯一持有 `items` / `total` / `hasMore` 以及最后一次成功的展示身份。不得新增第二份 items 或分页缓存。
- 数据源：`windowControllerTaskListRegistry` / `listTaskList` 仍是唯一查询入口；本次不改变 Controller 查询契约。

### 展示身份

展示身份是「除 `limit` 外的完整查询语义」，与现有 `queryKey` 逐字段同构：

```
kind + workspaceScopes + sortBy + search + searchTitlesOnly + includeArchived
```

- `limit` 不进入展示身份：同一身份下 `20 → 40`、`20 → undefined` 只是换窗口。
- `workspaceScopes`（含 path / workspaceIdentity）、`kind`、排序、搜索词、仅标题、包含归档任一变化都会改变展示身份，必须立即隐藏旧行，不能跨查询泄漏。
- `remoteSessionId` 仍只通过现有 `workspaceSourceGenerationSignature` 参与 `readinessKey`，不进入展示身份；其换代表现与改动前的 `dataQueryKey` 完全一致，不削弱也不扩大。

### 分页窗口变化

- **limit 增大（显示更多）**：继续展示最后一次成功结果中的已读前缀；`total` 沿用；`hasMore = 上次 hasMore || total > 当前 limit`。新一页成功后整体替换。
- **limit 缩小（收起）**：展示最后成功结果的前 `limit` 行；`total` 沿用；`hasMore = 上次 hasMore || total > limit`，保证剩余行仍可再次展开。内容变短后浏览器允许把 `scrollTop` 夹到新的最大值，但不得退回加载提示或清空 `total`/`hasMore`。
- **变成无上限（expanded）**：继续展示最后一次成功结果的全部已读行；`hasMore` 沿用，直到全量结果成功返回。
- **无上限变成有限 limit**：按当前 limit 截断已读行，不能因为旧结果更大就多显示。
- **limit 为 0 或非正数**：服务端 `normalizeLimit` 只在 `limit > 0` 时下推 LIMIT，0、负数、非有限值都按无上限查询；展示窗口也必须按无上限处理，不能把 0 当作 0 行。
- **同 limit 刷新**：沿用最后成功结果；`hasMore` 仍按 `上次 hasMore || (limit 有限且 total > limit)` 计算，后台重查。

### 加载语义

- `loading` 仍由 `readinessKey`（完整 queryKey + source generation）与 `settledQueryKey` 决定：当前读取尚未完成就是 true。
- 分页窗口变化时 `loading` 保持 true，但已有同展示身份数据时列表不为空，时间线不会进入 `items.length === 0 && loading` 的加载提示分支。
- 不把 `loading` 改成 false 来掩盖读取门控，也不新增 `refreshing` 等第二套状态。

### 失败与竞态

- 同一展示身份的分页请求失败：保留最后成功的前缀行、`total` 与 `hasMore`。不改变时间线既有的 `canLoadMore` 判定（20→40 失败后按钮可能隐藏），本 spec 不承诺「显示更多」按钮可重试；`useGlobalTaskList` 的 `refresh` 入口仍可重查，日志按现有错误路径记录。
- 展示身份变化后的请求失败：旧身份数据仍被展示身份门控隐藏，不得把旧 workspace / 旧搜索词的行显示成新查询结果。
- 旧请求晚到：继续由 `requestSerialRef` 丢弃非最新请求，只有最新请求能替换 `items` / `total` / `hasMore` / 展示身份。

### 明确不做

- 不硬设 `scrollTop` / `scrollIntoView`，不依赖 `setTimeout` 或滚动补偿。
- 不复制第二份列表数据，不在时间线组件里缓存分页结果。
- 不改变 Controller、ZCode 协议、桌面/手机通信方式；不新增 RPC 字段。
- 不改变 `WorkspaceTimelineTasksSection` 每次 20 条的阶梯，也不改归档视图的展开/收起交互。
- 不改变远程 workspace 的数据来源与 `useRemoteTimelineTaskStore` 的独立刷新链路。

## 接口

`useGlobalTaskList` 的入参与返回值不变。查询对象保持现有形态（含 `limit`），键由纯工厂派生：

```ts
buildGlobalTaskListQueryKeys(query: ZCodeTaskListQuery): {
  queryKey: JSON.stringify(query); // 含 limit
  displayQueryKey: JSON.stringify(queryWithoutLimit); // 不含 limit
}
```

`ZCodeTaskListQuery` 使用 `@zcode/services` 的公开类型；`workspaceSourceGenerationSignature` 不进入工厂，仍只参与 `readinessKey`。成功响应后记录 `dataDisplayQueryKey = displayQueryKey`，只有最新请求的成功响应会写入。

新增纯函数，用于派生当前展示窗口（供 hook 与测试共用，不构成第二份状态）：

```ts
resolveGlobalTaskListDataView({
  hasWorkspaceScope,
  currentDisplayQueryKey,
  dataDisplayQueryKey,
  items, // 最后一次成功的完整 items（hook 内唯一一份）
  total,
  hasMore,
  limit, // undefined 表示无上限
}): { items, total, hasMore }
```

规则：

1. 无 workspace scope，或展示身份不一致 → `{ items: [], total: 0, hasMore: false }`。
2. `limit` 先按服务端约定归一：只有正有限数生效；0、负数、非有限值视为无上限。
3. 展示身份一致且归一后无限 limit → 全部 items。
4. 归一后为有限 limit 且 `items.length > limit` → `items.slice(0, limit)`；否则返回原数组引用。
5. `hasMore = hasMore || (limit 有限且 total > limit)`。

## 不变量

- 同一展示身份下，limit 变化不会把非空的已读结果清空；`limit` 为 0、负数或非有限值时按服务端 `normalizeLimit` 约定视为无上限，不产生空窗口。
- 不同展示身份之间绝不共享可见行。
- 返回值最多只包含最后成功结果的行；分页不会凭空拼接未返回的行。
- `items` 在无需截断时保持原引用，避免下游 memo / 虚拟列表因新数组引用整体重算。
- 整条链路不存在第二份列表缓存、滚动位置写入或超时兜底。

## 事件顺序

```
用户点「显示更多」
  → WorkspaceTimelineTasksSection: visibleTaskLimit += 20        （分页窗口 owner）
  → useGlobalTaskList: queryKey 变化（含新 limit），displayQueryKey 不变
  → render: resolveGlobalTaskListDataView 命中同一展示身份
       → 返回最后成功的已读前缀 + 原 total/hasMore
       → 时间线不进入 items.length === 0 && loading，滚动内容不收缩
  → load(): requestSerial++，向 Controller 请求新 limit
  → 成功 && 仍是最新 serial:
       → items/total/hasMore = 新结果
       → dataDisplayQueryKey = displayQueryKey
  → finally && 仍是最新 serial: settledQueryKey = readinessKey
  → loading 变 false，列表保持新窗口

任一步失败 / serial 过期:
  → 不写 items/total/hasMore/dataDisplayQueryKey
  → 同一展示身份继续显示最后的可信前缀
```

## 桌面与手机

桌面 app 与手机 Web 共用 `packages/ui` 的同一 hook 和同一 Controller 查询契约。本次只调整 Renderer 内部的数据展示派生，不修改 `packages/shared/src/zcode-protocol`、订阅主题、快照或重连语义，也不区分 `desktop-continuous` 与 `web-remote-replayable`。因此两端行为一致，协议不改。

## 验收

1. 时间线超过 20 条，滚动到底点「显示更多」：点击瞬间列表仍显示已加载的 20 行和「显示更多」，不出现加载提示，滚动位置不回到顶部；新一页到达后追加到 40 行。
2. 归档视图点「显示更多」：已有归档行保持显示，不闪空、不回顶；点「显示更少」后回到 20 行，允许内容变短后 `scrollTop` 被夹到新的最大值，但不得退回加载提示，且剩余行仍可再次展开。
3. 切换 workspace、搜索词、排序、kind、仅标题或包含归档：旧查询的行立即消失，不跨查询泄漏。
4. 远程 workspace 的 `remoteSessionId` 换代：仍按现有 `readinessKey` 触发重查，不新增缓存或第二套 source 状态。
5. 同展示身份的分页请求失败：保留已展示行与 `hasMore`；不承诺「显示更多」按钮可重试，`refresh` 仍可重查；旧请求晚到不会覆盖新请求结果。
6. 纯函数单测覆盖：limit 增大、limit 缩小、无上限、展示身份不一致、无 scope、0/非正 limit 视为无上限，以及 `hasMore` 修正。
7. 浏览器级滚动回归（外部 E2E）：准备超过 20 条的本地时间线，滚动到侧栏底部后点击「显示更多」，断言点击前后 `scrollTop` 不回落、不出现加载提示、行数最终增加 20。当前仓库没有 jsdom / Playwright 组件测试依赖，且本次任务禁止启动或控制 YCode，因此只执行纯函数回归；组件级滚动需由具备外部浏览器 E2E 的环境补跑。
8. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；针对性单测命令：

```
cd packages/ui && node --import tsx --test test/globalTaskListLoadState.test.ts
```
