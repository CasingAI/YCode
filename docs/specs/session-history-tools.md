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
- `HistoryRead` 的 `role`：`assistant`（默认，只要模型的话）/ `user`（用户亲口说的话，剔除 hook 注入与命令包装等 `origin=system` 的消息）/ `both`（完整对话正文）。三类噪声统一剔除：非 user/assistant 角色、`semantics.kind=timeline_event`（模型切换等时间线事件）、`semantics.transcriptVisibility=hidden`（系统提醒、压缩摘要）。
- 段号坐标系：一个会话的「段」= 按 `time_created` 排序、经过上述噪声过滤（`role=both` 口径）后的每条消息的文本聚合。`HistorySearch` 命中的「段 N」可以用 `HistoryRead(role="both", fromSegment=N)` 精确落地；两者必须复用同一套过滤与拼装实现，不允许出现第二份坐标逻辑。
- 分页：`maxChars` 默认 24000，`0` 表示不截断（大会话会冲垮上下文，仅限明确需要全文时使用）；`fromSegment` 与 `offset` 互斥，`fromSegment` 优先；响应携带 `nextOffset` 供续读。
- 检索语义：多关键词空格分隔为 AND；返回命中片段（命中位置 ±90 字符、压平换行、关键词 `【】` 高亮）；时间窗（`days`）与数量上限（`limit`）限制扫描范围。

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
- 不新增 UI 专用工具卡、不改 zcode-protocol。

## 验收场景

1. `HistoryList` 默认返回最近 7 天会话（不含 `sess_subagent_*`），含 id/标题/目录/消息数/更新时间；`days`、`limit`、`workspace`、`withSubagents` 过滤生效。
2. `HistoryRead(role="both", sessionId=…)` 返回该会话逐字正文，包含压缩之前的消息；`transcriptVisibility=hidden` 的系统消息与 `origin≠real_user` 的伪 user 消息不出现。
3. `HistorySearch(query=…)` 命中「会话 A 段 N」后，`HistoryRead(role="both", fromSegment=N)` 从该段原文开始返回（坐标系一致）。
4. 分页：默认 `maxChars=24000` 截断并给出 `nextOffset`；`maxChars=0` 返回全文；`fromSegment` 优先于 `offset`；越界给出明确业务失败文案。
5. 会话不存在 → `status=not_found`；会话无符合条件的正文 → 明确提示（如纯工具调用会话）。
6. 端口缺席（未接线的宿主）→ 报 `ConfigurationError`，不静默返回假数据；`sessionMessageCounts` 缺席 → `HistoryList` 正常返回、仅省略 `messageCount`。
7. 工具免审批直接执行；hook/权限规则按 `HistoryList`/`HistoryRead`/`HistorySearch` 工具名匹配。
