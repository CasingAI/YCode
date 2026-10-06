# Spec: 命令中心搜索（Command Center Search）

命令中心（`packages/ui/src/command-center/CommandCenterDialog.tsx`）是跨 workspace 的全局搜索浮层。本 spec 约束其搜索范围、匹配规则与结果展示形态。任务搜索的服务端所有者是 `TaskIndexRepo`（`packages/services/src/session/taskIndexRepo.ts`，tasks-index.sqlite），前端不持有第二份可搜索事实。

## 范围（Scope）

- 范围 tab：`all`（全部）/ `commands`（操作）/ `conversations`（任务）/ `files`（文件）。
- 输入前缀可显式指定范围：`>` = commands、`#` = conversations、`@` = files；无前缀 = `all`。
- 显式前缀优先于手动点击的 tab；无前缀时以手动 tab 为准。
- 搜索历史（localStorage，按 workspaceKey 隔离）记录 `query + scope`；不记录「仅标题」开关状态。

## 任务（会话）搜索匹配规则

- 搜索范围：未归档会话（置顶 + 时间线）。置顶会话与时间线会话同等参与全文与仅标题匹配，不得因置顶被排除；归档会话不参与搜索。SQL 过滤语义必须与 `matchesTaskListMembershipKind` 的 `active` 判定（未归档即命中）一致。
- 默认（全文）：`LOWER(title) LIKE %q% OR LOWER(searchable_text) LIKE %q%`。`searchable_text` 由会话消息构建，写入时截断到 200,000 字符。
- 仅标题（`searchTitlesOnly: true`）：只匹配 `LOWER(title) LIKE %q%`，不扫描 `searchable_text`，也不构建正文摘要（结果项不含 `searchSnippet`/`searchSnippets`）。
- 关键词按空白拆分后需全部命中（AND 语义，大小写不敏感）。
- 「仅标题」入口：范围 tab 行右侧的开关 chip，仅在范围包含任务（`all`/`conversations`）时显示；默认关闭；弹窗关闭时重置为关闭。

## 正文摘要（Snippet）规则

- 以每个匹配点为中心截窗（前 20 / 后 72 字符），窗口重叠去重，最多 4 条（`TASK_SEARCH_SNIPPET_LIMIT`）。
- 标题命中但正文未命中时，回退返回 1 条正文开头摘要。
- 仅标题模式下不返回摘要。

## 结果展示（会话分区）

- **一个任务一行**：同一任务的多个命中片段合并在一个列表项内；行内展示标题 + 首条片段；若还有剩余命中片段（`extraSnippetCount > 0`），行尾显示 `+N` 徽标。
- 点击行为：携带查询词与首条片段发出 `ChatSearchResultHighlightRequest`，聊天视图按片段文本优先定位（`snippetIndex` 仅兜底）滚动并临时高亮。
- 「全部」范围下会话分区默认预览 3 行，可展开查看全部（`commandCenter.moreResults`）。

## 状态所有权与边界

- 搜索匹配唯一所有者是 TaskIndexRepo（SQLite 查询 + snippet 构建）；Renderer 只做行合并展示，不重复过滤正文。
- 查询对象 `ZCodeTaskListQuery` 经 `IWindowControllerService.listTaskList` channel RPC 透传；Host 对多 source 展开 `{...query}`，未知字段对旧对端无害（向后兼容）。
- 远端 workspace 对端为旧版本时忽略 `searchTitlesOnly`，返回全文结果，属可接受降级，前端不做二次过滤。

## 验收场景

1. 输入仅出现在某会话正文中的关键词：该会话以一行呈现，显示首条命中片段；多个命中片段时行尾出现 `+N`。
2. 打开「仅标题」后，正文命中但标题未命中的会话不再出现；结果行只有标题，无片段副行。
3. 打开「仅标题」后输入某会话标题关键词：该会话出现且不显示片段。
4. 点击合并后的行：跳转到对应会话的首条命中位置并临时高亮。
5. 「全部」范围下单个会话无论命中多少片段，最多占用一个预览行位。
6. 关闭再打开命令中心，「仅标题」恢复为关闭，范围恢复「全部」。
7. 置顶会话标题包含关键词时，全文与仅标题模式均命中该会话；`timeline` 查询仍排除置顶会话。
