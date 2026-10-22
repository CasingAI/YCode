# Spec: Session History 内置工具（HistoryList / HistoryRead / HistorySearch）

## 目标

把「查会话存档」能力固化为 always-on 内置系统工具，替代此前由用户级 MCP server（`mcp__history__list / read / search`）承担的角色：

- `HistoryList`：列出最近会话（id、标题、目录、消息数、时间），解决「不知道 session id」的发现问题。
- `HistoryRead`：读取一个会话的**逐字原文**（含上下文压缩之前的全部内容），支持按角色过滤与分页。
- `HistorySearch`：跨会话按关键词检索对话正文，返回命中片段和坐标（session id + 段号）。

历史说明：曾存在摘要式工具 `ReadSessionContext`（内部过提取模型，受 query 驱动、有界，拿不到逐字原文），现已移除。本组工具直接给出存档原文。`#sess_*` 引用的提醒现指向本组工具：先 `HistorySearch` 定位相关片段，再 `HistoryRead` 逐字读取。压缩（compact）只把早期消息移出 prompt，存储层原文一条不删，所以「读取完整原文」不需要任何开关。

## 产品规则

- 三个工具为 always-on 内置工具（无灰度门），主会话与子代理运行时均可注册。
- 全部只读免审批（`readOnly=true`、`needsApproval=false`、`riskLevel=low`）；底层只读 `SessionStorePort`，不产生任何写路径。SQLite 宿主上 List/Read/Search 的会话库扫描走只读旁路（独立线程 + 一次性只读连接），主连接继续服务打开会话与 UI；测试替身 / 内存库没有旁路方法时，handler 仍走 `listSessions` / `getSession` / `messages` 的内存循环。
- 默认隐藏子代理会话（`sess_subagent_` 前缀）；`withSubagents=true` 时才纳入。默认排除已归档会话；`includeArchived=true` 时才纳入（`HistoryList` 与 `HistorySearch` 语义一致）。归档不影响存档可读性：显式纳入后归档会话仍可列出与检索。默认排除时结果必须回告（`scopeNote` 含「已排除已归档会话（如需包含请传 includeArchived=true）」），显式纳入时 `scopeNote` 含「含已归档会话」，供模型决定是否追加一次显式查询。
- 默认隐藏 AI 历史搜索一次性会话（`sess_ai_search_` 前缀 / `ai_history_search` 任务类型，见 `docs/specs/command-center-ai-history-search.md`）；`withSubagents=true` 时才纳入（与子代理会话同一开关，不另开参数）。避免一次 AI 搜索搜到搜索过程自己。
- `HistoryRead` 的 `sessionId` 可选：缺省读当前会话（`ToolExecutionContext.sessionId`）；显式传入时仍走 `sess_*` 格式校验。输出的 `sessionId` 始终为解析后实际使用的 ID。
- `HistoryRead` 的 `role`：`both`（默认，完整对话正文）/ `assistant`（只要模型的话，想省 token 回顾旧结论时显式用）/ `user`（用户亲口说的话，剔除 hook 注入与命令包装等 `origin=system` 的消息）。三类噪声统一剔除：非 user/assistant 角色、`semantics.kind=timeline_event`（模型切换等时间线事件）、`semantics.transcriptVisibility=hidden`（系统提醒、压缩摘要）。
- 已知限制：读本会话只读 `SessionStorePort` 已持久化部分，当前轮尚未落盘的尾巴可能读不到；这是存储层的固有延迟，不是工具缺陷。
- `HistoryRead` 的模型可见文本附带该会话的**工具调用总次数**（`toolCallCount`）。计数是会话级事实，不随 `role` 过滤变化：工具 part 挂在 assistant message 上，`role=user` 时正文为空但计数仍为全会话总数。计数只给次数，不给工具名、参数或输出，也不改变「只返回对话正文」的口径。用途：纯工具调用会话（尤其是子代理会话）的正文可能极少，模型据此判断该会话的工作量。
- 「会话无符合条件的正文」分支同样携带计数。纯工具调用会话正是最需要这个信息的场景，该分支不得只报「没有正文」而隐去已有工作量。
- 段号坐标系：一个会话的「段」= 按 `time_created` 排序、经过上述噪声过滤（`role=both` 口径）后的每条消息的文本聚合。`HistorySearch` 命中的「段 N」可以用 `HistoryRead(role="both", fromSegment=N)` 精确落地；两者必须复用同一套过滤与拼装实现，不允许出现第二份坐标逻辑。
- 分页：`HistoryList` 的 `offset`（默认 0）作用在**过滤之后**的列表上（与 SQL `OFFSET` 无关：过滤在内存里、在 `listSessions` 之后，SQL 分页会分页到未过滤集合）；`limit` 上限 500；输出带 `total`（扫描窗口内匹配总数）、`offset`（回显）、`truncated`（被 limit 或扫描窗口截断时 true）；模型文本截断时给出“第 X-Y 个 · 共 N 个（还有更多，传 offset=…续查）”。
- 分页：`HistorySearch` 同样支持 `offset`（默认 0）+ `limit` 命中分页：先扫完全部候选会话收集全部命中，再在内存里按 `offset/limit` 切页；输出带 `total`（全部命中数）、`offset`（回显）、`truncated`（`offset + 本页条数 < total` 时 true）；模型文本截断时给出“第 X-Y 个 · 共 N 个（还有更多，传 offset=…续查）”，与 `HistoryList` 同一版式。
- `HistorySearch` 不设上限：`limit` 无最大值（想搜多少搜多少，缺省 20 条只是默认页大小）；跨会话候选不设会话扫描 cap（`listSessions` 不传 limit，全量按更新时间倒序取回再按 `days` 过滤）。候选默认排除已归档（`includeArchived` 缺省 false，走 `time_archived is null` 过滤），`includeArchived=true` 才纳入。
- `HistorySearch` 默认时间窗 90 天（`HISTORY_DEFAULT_SEARCH_DAYS = 90`，上限仍 365 天）；`sessionId` 限定搜索不受时间窗影响。
- 分页：`maxChars` 默认 24000，`0` 表示不截断（大会话会冲垮上下文，仅限明确需要全文时使用）；`fromSegment` 与 `offset` 互斥，`fromSegment` 优先；响应携带 `nextOffset` 供续读。
- 检索语义：多关键词空格分隔为 AND；返回命中片段（命中位置 ±90 字符、压平换行、关键词 `【】` 高亮）；时间窗（`days`，默认 90 天、上限 365 天）限制候选范围；`limit` 无上限（缺省 20，需要多少传多少），`offset`（默认 0）翻页；候选会话全量扫描（不设会话数 cap）。
- 范围口径（`scopeNote`）：只宣称「实际扫描」的范围，不宣称过滤窗口。时间窗只决定候选集，且命中 `limit` 提前 break 后排在后面的候选不会被读取，因此跨会话搜索的 `scopeNote` 必须报告实际读取正文的会话数（被截断时为 `已扫/候选`）与这些会话 `time.updated` 的真实跨度（`更新于 MM-DD ~ MM-DD`，跨年带年份）；候选为空时无跨度可报，才回退报告时间窗（`最近 N 天 · 0 个会话`），供模型据此加大 `days`。归档口径必须同时回告：默认排除时 `scopeNote` 含「已排除已归档会话（如需包含请传 includeArchived=true）」，显式纳入（`includeArchived=true`）时含「含已归档会话」；`HistoryList` 的 `scopeNote` 同一规则。

## 与用户级 history MCP server 的语义对照

并存观察期间两套工具同时可见；内置实现与 MCP server（`~/.zcode/mcp/history/server.js`）逐项对齐：

| 语义        | mcp**history**\*                           | 内置工具                                                            |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------- |
| 消息过滤    | wantMessage（role/kind/visibility/origin） | 同一规则，移植为 `session-history.ts` 纯函数                        |
| 段号坐标    | 同上过滤 + `time_created` 排序 + 文本 join | `buildTurns("both")` 单一实现，search/read 共用                     |
| 翻页        | offset / max_chars / from_segment          | 同名参数（camelCase），同一换算                                     |
| 片段        | ±90 字符压平 + `【】` 高亮                 | `makeSnippet` 同版式                                                |
| list 消息数 | SQL 子查询 count                           | `SessionStorePort.sessionMessageCounts`（可选方法，缺席时省略该列） |
| 归档会话    | 无概念（全查）                             | 默认排除已归档，`includeArchived: true` 才纳入并在 `scopeNote` 回告「含已归档会话」 |
| 数据通路    | 直查 SQLite（只读）                        | SQLite 宿主走只读旁路（独立线程、一次性 `{ readOnly: true }` 连接）；其它宿主 / 测试替身走 `SessionStorePort` 读方法 |

用户级 MCP 注册的启用/移除属于用户配置决策，不在本 spec 范围内。（`ReadSessionContext` 已移除，不再并存。）

## 状态所有者与数据流

```text
Tool handler (HistoryList/Read/Search)
  ├─ 有 SessionStorePort.runIsolatedHistoryJob（SQLite 文件库）
  │    └─ 进程内旁路队列（同时只一路）
  │         └─ 工作线程：打开 { readOnly: true } 连接 → 扫描/过滤/拼装 → 关闭连接 → 退出
  │              └─ 只把 List/Read/Search 结构化 Output 搬回运行时线程
  └─ 无旁路方法（测试替身、:memory:、其它宿主）
       └─ listSessions / getSession / messages / sessionMessageCounts?
            └─ 同一套过滤/拼装/分页/片段纯函数
                 └─ 结构化 Output + formatModelContent（模型文本）
```

- 会话事实的唯一所有者是 `SessionStorePort`（SQLite adapter 实现）。工具无缓存、无第二份索引、无派生状态；每次调用现读。
- 消息过滤、段号拼装、分页换算、命中片段的唯一实现是 `@zcode/contracts` 的会话存档投影纯函数；adapters 旁路工作线程与 core handler 共用这一套坐标，禁止第二份 `buildTurns`。
- SQLite 文件库上，List/Read/Search 的会话库扫描是旁路的唯一读路径：主连接的 `messages()` 等仍给冷恢复和其它调用者，这三件工具不再走它们。
- 旁路同时只跑一路：工具调度仍可标可并行，真正互斥在存储旁路，避免三路同时钉 WAL 快照、三路同时扫盘。
- 旁路连接用完即关：每次调用打开一条只读连接，结果返回或取消后立即关闭并结束线程。不常驻连接池、不跑迁移。快照寿命等于这一次调用；长扫描期间 WAL 日志可能涨，结束后检查点可能顿一下，可接受。
- 取消即杀：工具 `abortSignal`（停子代理、切走、命令中心 AI 搜取消、超时）终止当前工作线程并关闭连接；仍在排队的作业直接取消、不再开连接。
- 旁路失败（工作线程崩溃、只读打开 busy、工作线程入口缺失）返回已有 `failed`，不污染主连接、不让打开会话失败。
- 输出 double-channel：结构化 Output schema（contracts 严格校验）+ `formatModelContent`（模型可见文本，与 MCP server 版式一致）；`formatModelContent` 仍在 handler，不进旁路。
- 工作线程入口必须真能被桌面/远端进程打开，不是只把「找不到」换成另一句报错：
  - 禁止在 CJS 单文件产物里对 `import.meta.url` 调字符串方法（esbuild 打成 `zcode.cjs` 后 `import.meta` 是空对象，会变成 `undefined.endsWith`，三件套全部 `failed`）。
  - adapters 的 tsc / 源码测试：sibling `history-read-lane-worker.js`（源文件测试改拉编译产物）。
  - 桌面、远端、独立 CLI：构建把工作线程打成 `zcode.cjs` 同级的 `history-read-lane-worker.cjs`，并暂存进 `bundled-agents/<platform>/glm`；运行时用入口文件自己的目录定位这份文件（与引擎 wasm 同一套 CJS 定位），不读 `import.meta.url`。
  - SEA：同一份打进 asset，首次使用时物化到临时目录再拉起线程。
  - 不把 repository 再内联进 `eval: true` 源字符串。

## 接口

- schema：`@zcode/contracts` `tools/history.ts`（`HISTORY_LIST_TOOL_NAME` / `HISTORY_READ_TOOL_NAME` / `HISTORY_SEARCH_TOOL_NAME`）。
- port：`SessionStorePort` 可选方法：
  - `sessionMessageCounts?(input: { sessionIDs: SessionId[] }): Promise<Record<string, number>>`；SQLite adapter 实现为单条 group-by 查询，无 schema migration。其他宿主/测试替身可不实现，`HistoryList` 降级为省略 `messageCount` 字段。
  - `runIsolatedHistoryJob?(job, { signal })`：一次提交 List / Read / Search 作业和取消信号，返回与三件套 Output 同形的结构化结果。SQLite 文件库实现为只读旁路；未实现则 handler 走内存循环（核心单测、假 store 不改行为）。`:memory:` 或没有文件路径的 store 不走旁路（第二条连接读不到同一份内存库），查询仍在该 store 自己的读方法上完成。
- handler：`packages/core/src/tool/handlers/history-list.ts` / `history-read.ts` / `history-search.ts`，注册进 `handlers/index.ts` 的 `builtInTools`。有旁路方法就把整次作业交出去；没有则保持现有端口读 + 纯函数装配。
- 权限：`session.history.read`，`patternSources/alwaysAllowPatternSources = ["toolName"]`、`denyPriority = "beforeAsk"`（只读免审批档位）。
- 扫描上限（命名常量）：`HistoryList` 内部取最近 5000 个会话再过滤（默认排除已归档，`includeArchived=true` 才纳入）；`HistorySearch` 候选会话不设 cap（`listSessions` 不传 limit，全量按 `time_updated desc` 取回再按 `days` 过滤，同样默认排除已归档）。

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
- **display 通道只承载用户口径**：模型指令（如「如需包含请传 includeArchived=true」）只进
  模型文本投影，不进 display 载荷。`scopeNote` 是写给模型的范围说明（含行动提示），原样透给
  用户会把参数名暴露到界面上。display 侧改用结构化 scope 事实（天数 / 子代理口径 / 归档口径
  / 目录关键词），文案由 UI 按当前语言拼装——顺带修掉 scopeNote 硬编码中文导致英文界面
  中英混排。
- **展开态显示文本投影**：`output.text`（即模型读到的同一段文本）放进等宽滚动块，不再
  raw JSON 转储。
- **纯只读**：卡上无按钮、无跳转；只保留工具卡框架自带的展开/收起与失败状态。
- **降级**：display 缺席（升级前 transcript、非 v4 宿主）时折叠行只剩 kindLabel，展开态
  仍显示文本投影；不出 raw JSON、不报错。

### display 载荷（三个 kind，与 contracts/shared 两侧 strict schema 逐字段同步）

| kind             | 字段                                                                                              | 折叠行示例                      |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| `history_list`   | `status: success\|failed`、`scope?`、`sessionCount`、`total?`、`truncated?`                       | 列出会话 · 最近 7 天 · 5 个会话 |
| `history_search` | `status: success\|failed\|not_found`、`query(≤120)`、`hitCount`、`total?`、`offset?`、`truncated` | 搜索会话 · "关键词" · 3 个命中  |
| `history_read`   | `status: success\|failed\|not_found`、`title?(≤120)`、`sessionId`、`truncated?`                   | 读取会话 · 《标题》             |

`history_list.scope` 是结构化范围事实，取代原先的 `scopeNote` 字符串：

| 字段            | 类型                              | 含义                                       |
| --------------- | --------------------------------- | ------------------------------------------ |
| `days`          | `number`（1..365）                | 时间窗天数（缺省即 `HISTORY_DEFAULT_LIST_DAYS`） |
| `withSubagents` | `boolean`                         | 是否纳入子代理会话                         |
| `includeArchived` | `boolean`                       | 是否纳入已归档会话                         |
| `workspace`     | `string?`（≤200）                 | 标题/目录关键词过滤（缺省表示未按关键词过滤） |

文案由 UI 用 i18n 词条拼装（`chat.toolCall.history.scope.*`），分隔符与语序都属于展示层，
display 载荷不携带任何成品句子。旧版载荷里的 `scopeNote` 保留为 optional 兼容字段：新载荷不再
写它，UI 在 `scope` 缺席时回退读 `scopeNote`（升级前 transcript / 旧构建 CLI），因此旧帧的
折叠行不退化。

限长常量：`HISTORY_DISPLAY_MAX_TITLE_CHARS = 120`、`HISTORY_DISPLAY_MAX_QUERY_CHARS = 120`、
`HISTORY_DISPLAY_MAX_SCOPE_NOTE_CHARS = 160`（仅用于兼容旧 `scopeNote` 字段）。文本超长由
构造侧截断并打 `truncated`。

折叠行降级补一条（渲染侧）：`HistorySearch` 的 query 同时存在于 `toolCall.input`，display
缺席（旧构建 CLI、升级前 transcript）或运行中时，折叠行退回输入侧的纯关键词
（`"query"`，无命中数）——「搜的是什么」不依赖结果载荷。`HistoryRead` 折叠行只回答
「读了哪个会话」：标题或 sessionId，不带段坐标等细节；段坐标没有消费者就不进载荷
（resume_workflow_run 同一惯例）。

### 状态所有者与数据流

```text
HistoryList/Read/Search handler 输出（唯一事实所有者，不变）
  └─ core createHistoryDisplay：safeParse 输出 schema → 极简载荷（boundDisplayText 限长）
       │  HistoryList 另从工具入参派生结构化 scope 事实（天数/子代理/归档/目录关键词）
       └─ contracts toolResultDisplayPayloadSchema union（持久化 metadata 校验）
            └─ bootstrap toProtocolToolCallDisplay 白名单（v4 wire 放行）
                 └─ shared toolResultDisplaySchema / toolCallDisplaySchema 双 union（渲染侧镜像校验）
                      └─ UI toolResultDisplay 查表 → renderers/history.tsx 三卡
                           └─ scope 事实经 i18n 词条拼成用户口径文案（scope 缺席时回退旧 scopeNote）
```

新增 kind 必须同回合改齐：contracts 载荷 schema、contracts union、shared 镜像 schema、
shared 双 union、bootstrap 白名单——任何一侧 strict 缺成员，整块 display 被剥、卡退化成
kindLabel 一行（fail-closed，不报错）。

### 卡面验收场景

1. HistoryList 折叠行显示「列出会话 · {scope 文案} · N 个会话」；scope 文案由结构化 scope 事实经 i18n 拼装（默认「最近 7 天」，子代理与归档口径按事实追加），不含任何参数名或调用指引；空结果显示「没有符合条件的会话」；展开为文本投影滚动块。
2. HistorySearch 折叠行显示「搜索会话 · "query" · N 个命中」；无命中显示「无命中」；`truncated` 时展开区尾注「仅显示部分命中」；display 缺席或运行中时折叠行仍显示 `"query"`（输入侧兜底）。
3. HistoryRead 折叠行显示「读取会话 · 《标题》」（标题缺席用 sessionId），不显示段坐标等细节；展开为原文投影滚动块。
4. 升级前 transcript（无 display）：三卡退化为 kindLabel 一行 + 文本投影块（Search 有关键词兜底），无报错、无 raw JSON。
5. 业务失败（`status=failed` / `not_found`）：折叠行给出对应文案，不静默空白。
6. 模型侧回归：三工具的模型文本投影与改动前逐字一致。
7. 折叠行箭头（展开入口）与其他工具卡一致：有无由「是否存在可展开内容」决定，位置由公共 ToolLayout 保证。
8. 用户口径纯净：HistoryList 折叠行（及其展开态文本投影之外的任何 display 字段）不出现 `includeArchived` 等参数名，也不出现「如需包含请传 …」这类调用指引；这些只存在于模型文本投影里。
9. 旧帧兼容：升级前 transcript 的 display 载荷只有 `scopeNote`，折叠行回退显示该文案（不退化为 kindLabel 一行），且新载荷不再写 `scopeNote`。

## 验收场景

1. `HistoryList` 默认返回最近 7 天会话（不含 `sess_subagent_*`，不含已归档会话），含 id/标题/目录/消息数/更新时间；`days`、`limit`（上限 500）、`offset`、`workspace`、`withSubagents`、`includeArchived` 过滤/分页生效；输出 `total`/`truncated` 标识截断；扫描窗口饱和时 `truncated=true`。默认排除时 `scopeNote` 含归档回告文案，`includeArchived=true` 时含「含已归档会话」。
2. `HistoryRead` 默认返回完整对话（`role` 缺省即 `both`），含用户原话与模型回答，包含压缩之前的消息；`transcriptVisibility=hidden` 的系统消息与 `origin≠real_user` 的伪 user 消息不出现。显式 `role="assistant"` 时只返回模型的话。模型可见文本附带该会话的工具调用总次数。
3. `HistorySearch(query=…)` 命中「会话 A 段 N」后，`HistoryRead(role="both", fromSegment=N)` 从该段原文开始返回（坐标系一致）。
4. 分页：默认 `maxChars=24000` 截断并给出 `nextOffset`；`maxChars=0` 返回全文；`fromSegment` 优先于 `offset`；越界给出明确业务失败文案。
5. 会话不存在 → `status=not_found`；会话无符合条件的正文 → 明确提示（如纯工具调用会话），且该提示带上该会话的工具调用总次数，不得因正文为空而隐去已有工作量。
6. 端口缺席（未接线的宿主）→ 报 `ConfigurationError`，不静默返回假数据；`sessionMessageCounts` 缺席 → `HistoryList` 正常返回、仅省略 `messageCount`。
7. 工具免审批直接执行；hook/权限规则按 `HistoryList`/`HistoryRead`/`HistorySearch` 工具名匹配。
8. `HistorySearch` 的 `scopeNote` 反映实际扫描：跨会话展示扫描会话数与已扫会话的更新时间跨度；命中上限提前截断时展示 `已扫/候选` 且跨度只覆盖已扫部分；候选为空回退时间窗文案。归档口径同步回告：默认排除时含「已排除已归档会话（如需包含请传 includeArchived=true）」，显式纳入时含「含已归档会话」。
