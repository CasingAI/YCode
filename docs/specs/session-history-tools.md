# Spec: Session History 内置工具（HistoryList / HistoryRead / HistorySearch）

## 目标

把「查会话存档」能力固化为 always-on 内置系统工具，替代此前由用户级 MCP server（`mcp__history__list / read / search`）承担的角色：

- `HistoryList`：列出最近会话（id、标题、目录、消息数、时间），解决「不知道 session id」的发现问题。
- `HistoryRead`：读取一个会话的**逐字原文**（含上下文压缩之前的全部内容），支持按角色过滤与分页。
- `HistorySearch`：跨会话按关键词检索对话正文，返回命中片段和坐标（session id + 段号）。

与 `ReadSessionContext` 的分工：后者是摘要式（内部过提取模型，受 query 驱动、有界），拿不到逐字原文；本组工具直接给出存档原文。压缩（compact）只把早期消息移出 prompt，存储层原文一条不删，所以「读取完整原文」不需要任何开关。

## 产品规则

- 三个工具为 always-on 内置工具（无灰度门），主会话与子代理运行时均可注册。
- 全部只读免审批（`readOnly=true`、`needsApproval=false`、`riskLevel=low`）；底层只调用 `SessionStorePort` 的读方法，不产生任何写路径。
- 默认隐藏子代理会话（`sess_subagent_` 前缀）；`withSubagents=true` 时才纳入。会话列表包含已归档会话（`includeArchived: true`），归档不影响存档可读性。
- `HistoryRead` 的 `sessionId` 可选：缺省读当前会话（`ToolExecutionContext.sessionId`）；显式传入时仍走 `sess_*` 格式校验。输出的 `sessionId` 始终为解析后实际使用的 ID。
- `HistoryRead` 的 `role`：`both`（默认，完整对话正文）/ `assistant`（只要模型的话，想省 token 回顾旧结论时显式用）/ `user`（用户亲口说的话，剔除 hook 注入与命令包装等 `origin=system` 的消息）。三类噪声统一剔除：非 user/assistant 角色、`semantics.kind=timeline_event`（模型切换等时间线事件）、`semantics.transcriptVisibility=hidden`（系统提醒、压缩摘要）。
- 已知限制：读本会话只读 `SessionStorePort` 已持久化部分，当前轮尚未落盘的尾巴可能读不到；这是存储层的固有延迟，不是工具缺陷。
- 段号坐标系：一个会话的「段」= 按 `time_created` 排序、经过上述噪声过滤（`role=both` 口径）后的每条消息的文本聚合。`HistorySearch` 命中的「段 N」可以用 `HistoryRead(role="both", fromSegment=N)` 精确落地；两者必须复用同一套过滤与拼装实现，不允许出现第二份坐标逻辑。
- 分页：`maxChars` 默认 24000，`0` 表示不截断（大会话会冲垮上下文，仅限明确需要全文时使用）；`fromSegment` 与 `offset` 互斥，`fromSegment` 优先；响应携带 `nextOffset` 供续读。
- 检索语义：多关键词空格分隔为 AND；返回命中片段（命中位置 ±90 字符、压平换行、关键词 `【】` 高亮）；时间窗（`days`）与数量上限（`limit`）限制扫描范围。
- 范围口径（`scopeNote`）：只宣称「实际扫描」的范围，不宣称过滤窗口。时间窗只决定候选集，且命中 `limit` 提前 break 后排在后面的候选不会被读取，因此跨会话搜索的 `scopeNote` 必须报告实际读取正文的会话数（被截断时为 `已扫/候选`）与这些会话 `time.updated` 的真实跨度（`更新于 MM-DD ~ MM-DD`，跨年带年份）；候选为空时无跨度可报，才回退报告时间窗（`最近 N 天 · 0 个会话`），供模型据此加大 `days`。

## 与用户级 history MCP server 的语义对照

并存观察期间两套工具同时可见；内置实现与 MCP server（`~/.zcode/mcp/history/server.js`）逐项对齐：

| 语义        | mcp**history**\*                           | 内置工具                                                            |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------- |
| 消息过滤    | wantMessage（role/kind/visibility/origin） | 同一规则，移植为 `session-history.ts` 纯函数                        |
| 段号坐标    | 同上过滤 + `time_created` 排序 + 文本 join | `buildTurns("both")` 单一实现，search/read 共用                     |
| 翻页        | offset / max_chars / from_segment          | 同名参数（camelCase），同一换算                                     |
| 片段        | ±90 字符压平 + `【】` 高亮                 | `makeSnippet` 同版式                                                |
| list 消息数 | SQL 子查询 count                           | `SessionStorePort.sessionMessageCounts`（可选方法，缺席时省略该列） |
| 归档会话    | 无概念（全查）                             | `includeArchived: true`，行为等价                                   |
| 数据通路    | 直查 SQLite（只读）                        | `SessionStorePort`（adapters 层 SQLite，只读方法）                  |

用户级 MCP 注册的启用/移除属于用户配置决策，不在本 spec 范围内。

## 状态所有者与数据流

```text
Tool handler (HistoryList/Read/Search)
  └─ SessionStorePort.listSessions / getSession / messages / sessionMessageCounts?
       └─ SQLite adapter（唯一持久化所有者，只读路径）
            └─ handler 内纯函数（过滤/拼装/分页/片段）
                 └─ 结构化 Output + formatModelContent（模型文本）
```

- 会话事实的唯一所有者是 `SessionStorePort`（SQLite adapter 实现）。工具无缓存、无第二份索引、无派生状态；每次调用现读。
- 消息过滤、段号拼装、分页换算的唯一实现是 `packages/core/src/session-history/session-history.ts` 纯函数模块；三个 handler 只做端口调用与装配。
- 输出 double-channel：结构化 Output schema（contracts 严格校验）+ `formatModelContent`（模型可见文本，与 MCP server 版式一致）。

## 接口

- schema：`@zcode/contracts` `tools/history.ts`（`HISTORY_LIST_TOOL_NAME` / `HISTORY_READ_TOOL_NAME` / `HISTORY_SEARCH_TOOL_NAME`）。
- port：`SessionStorePort` 新增可选方法 `sessionMessageCounts?(input: { sessionIDs: SessionId[] }): Promise<Record<string, number>>`；SQLite adapter 实现为单条 group-by 查询，无 schema migration。其他宿主/测试替身可不实现，`HistoryList` 降级为省略 `messageCount` 字段。
- handler：`packages/core/src/tool/handlers/history-list.ts` / `history-read.ts` / `history-search.ts`，注册进 `handlers/index.ts` 的 `builtInTools`（与 `readSessionContextToolEntry` 相邻）。
- 权限：`session.history.read`，`patternSources/alwaysAllowPatternSources = ["toolName"]`、`denyPriority = "beforeAsk"`（对齐 `ReadSessionContext` 的只读免审批档位）。
- 扫描上限（命名常量）：`HistoryList` 内部取最近 1000 个会话再过滤；`HistorySearch` 内部取最近 200 个会话再按 `days` 过滤。两侧均依赖 SQL 的 `time_updated desc` 排序，先取最近 N 条再按时间窗过滤，与 MCP server「时间窗内取最近 N 条」的结果集等价。

## 明确不做

- 不建全文索引（保持与 MCP server 相同的顺序扫描性能特征）。
- 不为旧 `mcp__history__*` 工具名注册 registry alias（旧 transcript 不重放）。
- 卡上不做会话跳转、复制等动作（纯只读展示；跳转需要跨会话导航链路，另立 spec）。

## 聊天工具卡（display payload 通道）

> 初版 spec 曾决策「不新增 UI 专用工具卡、不改 zcode-protocol」，三工具因此落进
> `FallbackToolCallBlock` 的 raw JSON 兜底卡。该决策已推翻：三工具各有一张专用聊天卡，
> 数据走既有 display payload 通道（与 list_models / list_workflow_runs 同款惯例）。

### 产品规则

- **模型通道零改动**：handler、Output schema、`formatModelContent` 文本投影全部保持原样；
  模型读到的工具结果与无卡时代逐字相同。display 载荷只挂协议 metadata
  （`completedToolPartMetadata.display`），由渲染层消费，不进模型上下文。
- **折叠行是一等公民**：每张卡折叠态给出一行结构化摘要（计数、query、标题、段坐标），
  数据来自 display 载荷，不解析文本投影。
- **展开态显示文本投影**：`output.text`（即模型读到的同一段文本）放进等宽滚动块，不再
  raw JSON 转储。
- **纯只读**：卡上无按钮、无跳转；只保留工具卡框架自带的展开/收起与失败状态。
- **降级**：display 缺席（升级前 transcript、非 v4 宿主）时折叠行只剩 kindLabel，展开态
  仍显示文本投影；不出 raw JSON、不报错。

### display 载荷（三个 kind，与 contracts/shared 两侧 strict schema 逐字段同步）

| kind             | 字段                                                                                              | 折叠行示例                                   |
| ---------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `history_list`   | `status: success\|failed`、`scopeNote?(≤160)`、`sessionCount`、`truncated?`                        | 列出会话 · 最近 7 天 · 5 个会话              |
| `history_search` | `status: success\|failed\|not_found`、`query(≤120)`、`hitCount`、`truncated`                       | 搜索会话 · "关键词" · 3 个命中               |
| `history_read`   | `status: success\|failed\|not_found`、`title?(≤120)`、`sessionId`、`truncated?`                    | 读取会话 · 《标题》                          |

限长常量：`HISTORY_DISPLAY_MAX_TITLE_CHARS = 120`、`HISTORY_DISPLAY_MAX_QUERY_CHARS = 120`、
`HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS = 160`。文本超长由构造侧截断并打 `truncated`。

折叠行降级补一条（渲染侧）：`HistorySearch` 的 query 同时存在于 `toolCall.input`，display
缺席（旧构建 CLI、升级前 transcript）或运行中时，折叠行退回输入侧的纯关键词
（`"query"`，无命中数）——「搜的是什么」不依赖结果载荷。`HistoryRead` 折叠行只回答
「读了哪个会话」：标题或 sessionId，不带段坐标等细节；段坐标没有消费者就不进载荷
（resume_workflow_run 同一惯例）。

### 状态所有者与数据流

```text
HistoryList/Read/Search handler 输出（唯一事实所有者，不变）
  └─ core createHistoryDisplay：safeParse 输出 schema → 极简载荷（boundDisplayText 限长）
       └─ contracts toolResultDisplayPayloadSchema union（持久化 metadata 校验）
            └─ bootstrap toProtocolToolCallDisplay 白名单（v4 wire 放行）
                 └─ shared toolResultDisplaySchema / toolCallDisplaySchema 双 union（渲染侧镜像校验）
                      └─ UI toolResultDisplay 查表 → renderers/history.tsx 三卡
```

新增 kind 必须同回合改齐：contracts 载荷 schema、contracts union、shared 镜像 schema、
shared 双 union、bootstrap 白名单——任何一侧 strict 缺成员，整块 display 被剥、卡退化成
kindLabel 一行（fail-closed，不报错）。

### 卡面验收场景

1. HistoryList 折叠行显示「列出会话 · {scopeNote} · N 个会话」；空结果显示「没有符合条件的会话」；展开为文本投影滚动块。
2. HistorySearch 折叠行显示「搜索会话 · "query" · N 个命中」；无命中显示「无命中」；`truncated` 时展开区尾注「仅显示部分命中」；display 缺席或运行中时折叠行仍显示 `"query"`（输入侧兜底）。
3. HistoryRead 折叠行显示「读取会话 · 《标题》」（标题缺席用 sessionId），不显示段坐标等细节；展开为原文投影滚动块。
4. 升级前 transcript（无 display）：三卡退化为 kindLabel 一行 + 文本投影块（Search 有关键词兜底），无报错、无 raw JSON。
5. 业务失败（`status=failed` / `not_found`）：折叠行给出对应文案，不静默空白。
6. 模型侧回归：三工具的模型文本投影与改动前逐字一致。
7. 折叠行箭头（展开入口）与其他工具卡一致：有无由「是否存在可展开内容」决定，位置由公共 ToolLayout 保证。

## 验收场景

1. `HistoryList` 默认返回最近 7 天会话（不含 `sess_subagent_*`），含 id/标题/目录/消息数/更新时间；`days`、`limit`、`workspace`、`withSubagents` 过滤生效。
2. `HistoryRead` 默认返回完整对话（`role` 缺省即 `both`），含用户原话与模型回答，包含压缩之前的消息；`transcriptVisibility=hidden` 的系统消息与 `origin≠real_user` 的伪 user 消息不出现。显式 `role="assistant"` 时只返回模型的话。
3. `HistorySearch(query=…)` 命中「会话 A 段 N」后，`HistoryRead(role="both", fromSegment=N)` 从该段原文开始返回（坐标系一致）。
4. 分页：默认 `maxChars=24000` 截断并给出 `nextOffset`；`maxChars=0` 返回全文；`fromSegment` 优先于 `offset`；越界给出明确业务失败文案。
5. 会话不存在 → `status=not_found`；会话无符合条件的正文 → 明确提示（如纯工具调用会话）。
6. 端口缺席（未接线的宿主）→ 报 `ConfigurationError`，不静默返回假数据；`sessionMessageCounts` 缺席 → `HistoryList` 正常返回、仅省略 `messageCount`。
7. 工具免审批直接执行；hook/权限规则按 `HistoryList`/`HistoryRead`/`HistorySearch` 工具名匹配。
8. `HistorySearch` 的 `scopeNote` 反映实际扫描：跨会话展示扫描会话数与已扫会话的更新时间跨度；命中上限提前截断时展示 `已扫/候选` 且跨度只覆盖已扫部分；候选为空回退时间窗文案。
