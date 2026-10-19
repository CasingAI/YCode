# Spec: 命令中心搜索（Command Center Search）

命令中心（`packages/ui/src/command-center/CommandCenterDialog.tsx`）是跨 workspace 的全局搜索浮层。本 spec 约束其搜索范围、匹配规则与结果展示形态。任务搜索的服务端所有者是 `TaskIndexRepo`（`packages/services/src/session/taskIndexRepo.ts`，tasks-index.sqlite），前端不持有第二份可搜索事实。

AI 会话搜索（自然语言问一句、得到归纳答案 + 可跳转引用）见 `docs/specs/command-center-ai-history-search.md`：与本 spec 的关键词搜索并存——有查询时列表第一项为「用 AI 搜索」，排在关键词分区之前；空查询不出现，默认近期列表不变；回答态、关闭回收、忙闲隔离的规则由该 spec 拥有，本 spec 不重复定义。

## 范围（Scope）

- 范围 tab：`all`（全部）/ `commands`（操作）/ `conversations`（任务）/ `files`（文件）。
- 输入前缀可显式指定范围：`>` = commands、`#` = conversations、`@` = files；无前缀 = `all`。
- 显式前缀优先于手动点击的 tab；无前缀时以手动 tab 为准。
- 搜索历史（localStorage，按 workspaceKey 隔离）记录 `query + scope`；不记录「仅标题」开关状态。「包含已归档」的选择按 workspaceKey 单独持久化（与搜索历史分 key）。

## 任务（会话）搜索匹配规则

- 搜索范围：默认未归档会话（置顶 + 时间线）。置顶会话与时间线会话同等参与全文与仅标题匹配，不得因置顶被排除。「包含已归档」关闭时归档会话不参与搜索，SQL 过滤语义必须与 `matchesTaskListMembershipKind` 的 `active` 判定（未归档即命中）一致；打开后 `active` 查询同时包含归档会话（仅影响搜索路径，侧栏 pinned/timeline/archived 视图不受影响）。
- 默认（全文）：`LOWER(title) LIKE %q% OR LOWER(searchable_text) LIKE %q%`。`searchable_text` 由会话消息构建，写入时截断到 200,000 字符。
- 仅标题（`searchTitlesOnly: true`）：只匹配 `LOWER(title) LIKE %q%`，不扫描 `searchable_text`，也不构建正文摘要（结果项不含 `searchSnippet`/`searchSnippets`）。
- 关键词按空白拆分后需全部命中（AND 语义，大小写不敏感）。
- 「仅标题」入口：范围 tab 行右侧的开关 chip，仅在范围包含任务（`all`/`conversations`）时显示；默认关闭；弹窗关闭时重置为关闭。
- 「包含已归档」入口（`includeArchived: true`）：紧邻「仅标题」的第二颗开关 chip，显示条件与「仅标题」相同；默认关闭，但**按 workspaceKey 持久化用户选择（localStorage），跨弹窗保留**——与「仅标题」的重置规则刻意不同：仅标题是单次查询偏好，包含已归档是搜索习惯，用户一旦表明倾向就应记住。命中结果项携带 `archived: true`，行内渲染「已归档」徽标；点击命中行打开会话的行为不变。

## 正文摘要（Snippet）规则

- 以每个匹配点为中心截窗（前 20 / 后 72 字符），窗口重叠去重，最多 4 条（`TASK_SEARCH_SNIPPET_LIMIT`）。
- 标题命中但正文未命中时，回退返回 1 条正文开头摘要。
- 仅标题模式下不返回摘要。

## 结果展示（会话分区）

- **一个任务一行**：同一任务的多个命中片段合并在一个列表项内；行内展示标题 + 首条片段；若还有剩余命中片段（`extraSnippetCount > 0`），行尾显示 `+N` 徽标。
- 点击行为：携带查询词与首条片段发出 `ChatSearchResultHighlightRequest`，聊天视图按片段文本优先定位（`snippetIndex` 仅兜底）滚动并临时高亮。
- 「全部」范围下会话分区默认预览 3 行，可展开查看全部（`commandCenter.moreResults`）。

## 输入防抖与加载语义

- 搜索框输入经约 200ms 防抖后才触发任务/文件搜索查询；连续输入过程中不发请求，列表保持上一次最终态，不出现加载占位。
- 搜索进行中时 loading 态收敛到输入框右侧（小转圈，与清空按钮互斥），结果分区不挂「搜索中」占位行。
- 分区只渲染最终态：0 结果时整组不出现（`return null`），有结果时标题 + 行一次性呈现；中间无「占位 → 卸载 → 结果」三态切换。
- 「用 AI 搜索」触发项的 cmdk `value` 使用固定值（不含查询词），仅标题文本随查询变化，避免每敲一字高亮重置。

## 状态所有权与边界

- 搜索匹配唯一所有者是 TaskIndexRepo（SQLite 查询 + snippet 构建）；Renderer 只做行合并展示，不重复过滤正文。
- 查询对象 `ZCodeTaskListQuery` 经 `IWindowControllerService.listTaskList` channel RPC 透传；Host 对多 source 展开 `{...query}`，未知字段对旧对端无害（向后兼容）。
- 远端 workspace 对端为旧版本时忽略 `searchTitlesOnly`/`includeArchived`，分别退化为全文结果/不含归档的结果，属可接受降级，前端不做二次过滤。

## 验收场景

1. 输入仅出现在某会话正文中的关键词：该会话以一行呈现，显示首条命中片段；多个命中片段时行尾出现 `+N`。
2. 打开「仅标题」后，正文命中但标题未命中的会话不再出现；结果行只有标题，无片段副行。
3. 打开「仅标题」后输入某会话标题关键词：该会话出现且不显示片段。
4. 点击合并后的行：跳转到对应会话的首条命中位置并临时高亮。
5. 「全部」范围下单个会话无论命中多少片段，最多占用一个预览行位。
6. 关闭再打开命令中心，「仅标题」恢复为关闭，范围恢复「全部」；「包含已归档」保持上次的选择（按 workspaceKey 持久化）。
7. 置顶会话标题包含关键词时，全文与仅标题模式均命中该会话；`timeline` 查询仍排除置顶会话。
8. 「包含已归档」关闭时，已归档会话标题/正文命中也不出现在结果中（与历史行为一致）。
9. 打开「包含已归档」后搜索：已归档会话出现在结果中且行内带「已归档」徽标；点击该行正常打开会话。
10. 打开「包含已归档」后关闭弹窗再打开：开关仍为打开状态；切到另一 workspaceKey 的 tab，开关回到该工作区自己的记忆值。
