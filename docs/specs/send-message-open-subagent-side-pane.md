# Spec: 主对话流 SendMessage 行点击打开子代理侧边视图

## 背景与目标

主对话流里 SendMessage 工具行（纸飞机图标 +「已发送」+ 灰色「给 XXX」）当前不可点击。
用户希望点击这一行直接进入该子代理的侧边视图（`sidePane` 内 `subagent-session` tab）
查看其会话。本次是接线工作：不新增面板、不改数据通道、不改协议、不新增外壳主视图
档位，只把已存在的两端（SendMessage 行的 `to` 目标 ↔ 既有 `subagent-session` tab 打开
链路）连起来。

模板与深度标准参照 `docs/specs/subagent-directory-side-pane.md`（子智能体目录）与
`docs/specs/subagent-status-footer.md`（子代理面板底部状态条）。
与两者的关系：目录是启动器与列表面，状态条是详情面板底部的常驻只读信息行
（三项均不可交互，保持不变），本 spec 是主对话流里的第三条入口，三者并存、互不改动。

## 状态所有者与数据流

```text
CLI V4 projection rows（SubagentRow 唯一权威：entityId / childSessionId / subagentType）
  → buildAgentSessionByIdentity(rows) 派生 entityId → { childSessionId, subagentType } 只读索引
  → ConversationTimeline memo 缓存（RowsTitleIndexMemo，行对象引用判据）
  → 与 runningSubagentSessionByIdentity 合并（行派生优先，快照 running 只补缺，见下）
  → renderRowContext
  → ConversationTurnGroup（缺席时按本轮 rows 回退构建）
  → ConversationRowRenderContext.agentSessionByIdentity（renderer 只读）
  → ToolCallRowView：SendMessage 行按 input.to 查表 + 绑定会话 scope，产出 agentSummaryAction
  → ToolCallBlock → SendMessageToolCallBlock → ToolLayout summaryAction（整行可点）
  → context.onOpenSubagentSession → SessionPane.handleOpenSubagentSession（补 workspace 身份）
  → useAppPanels.handleOpenSubagentSession → openSubagentSessionSidePane（幂等聚焦）
```

- 身份第一来源是**已加载会话行中的 SubagentRow 投影**：`childSessionId` 必须来自
  `SubagentRow.childSessionId`，`subagentType` 来自 `SubagentRow.subagentType`，
  键是 `SubagentRow.entityId`（与 SendMessage `input.to` 的 `agent_<uuid>` 同源）。
  **禁止**用字符串拼接（`sess_subagent_<agentId>` 之类）推导会话 id。
- 行派生索引只覆盖**已加载窗口**：长会话窗口截断或冷恢复后，派生那一刻的
  SubagentRow 不在窗内（SendMessage 自身不产生 SubagentRow，只有 Agent
  spawn/resume 发 `SubagentSpawned`），行派生查空会让已可交互的行静默退化为
  「只展开」。因此引入第二事实来源做**补位**：会话权威投影
  `snapshot.subagents.running`（`runningSubagentSummarySchema` 自带
  `agentId` = `SubagentRow.entityId`，与 `input.to` 同源；冷恢复经
  `seedSubagents` 种子，运行期由 `materializeSubagentProjection` 维护）。
  经 `buildRunningSubagentSessionByIdentity` 整理成同形索引
  （键 `running[].agentId`，值 `childSessionId` + `subagentType`），
  由 SessionPane 经 rowContext 字段 `runningSubagentSessionByIdentity` 下发，
  ConversationTimeline 用 `mergeAgentSessionByIdentity` 合并：**行派生命中的键
  永远以行为准，快照只补行派生查空的键**。已结束子代理（不在 running、行又被
  截断）仍按缺席处理，不为它扩协议或加查询。
- 无 childSessionId 的 SubagentRow（尚未 spawn / 历史缺口）不入索引，对应 SendMessage
  行保持现状（不可点、可展开），不报错。
- 索引是派生只读数据，不引入新状态所有者：tab 状态仍唯一归
  `commitOpenedSidePaneState` + `openSubagentSessionSidePane` 所有；
  tab id 仍为 `subagent-session:<workspaceKey>:<rootSessionId>:<childSessionId>`，
  同一三元组重复打开只聚焦已有 tab。
- 打开请求的 `title` 取 `agentTitleByIdentity` 同一标题（缺席时回退 `subagentType`），
  保证用户点击的可见标题与右侧 tab 标题逐字一致；与 Agent 工具行
  （`ConversationAgentToolCallRow`）同一口径。
- workspace 身份（`workspacePath` / `workspaceIdentity?` / `remoteSessionId?`）与
  `rootSessionId` 回退全部由 `SessionPane.handleOpenSubagentSession` 既有逻辑补齐，
  行侧只交 `parentSessionId`（= 当前 `context.sessionId`）、`childSessionId`、
  `subagentType`、`title`。分享只读视图不注入 `onOpenSubagentSession`，
  行侧随之无入口（与 `onOpenBackgroundBash` 的门控先例一致）；
  子代理侧边视图（`SubagentSessionSidePane` 内只读 `SessionPane`）**会**注入，
  用于嵌套子代理再下钻（`SessionPane.tsx:1834-1856`，`rootSessionId ??= parentSessionId`）。

## 产品规则

- 可打开条件（五者齐备才整行可点，缺一即回退现状）：
  1. 该 SendMessage 行经 `normalizeZCodeToolName` 归一后为 `SendMessage`
     （与渲染分派 `resolveRenderer.ts:179-181` 同一口径）；
  2. 适配后工具 input 的 `to` 非空（与 `SendMessageToolCallBlock` 的读取同源；
     v4 行的 raw 从不携带 input 记录，桥接只写 error/output/display，input 唯一
     通道是 `row.input` / `inputText` 流式预览）；
  3. `agentSessionByIdentity.get(to)` 命中且含 `childSessionId`（收件人会话可解析；
     该索引已是「行派生 ∪ 快照 running 补位」的合并结果）；
  4. 当前 `context.sessionId` 存在（作为 `parentSessionId`）；
  5. 宿主注入了 `context.onOpenSubagentSession`。
- 工具调用状态不参与判定：`SendMessage` 的工具完成指的是「收件人这一轮
  回复结束」（发给运行中子代理是即时投递，`deliverMessageToRunningAgent` 不等
  回复；发给已结束子代理则等前台续跑落定），不是「消息已投递」。
  用它当投递信号是错的——子智能体还在跑时收件人会话明明已存在，
  这一行却会被误判为不可点。因此运行中与失败/取消态只要收件人会话
  可解析，同样可点。
- 整行可点 = 打开侧边视图，走 `ToolLayout` 既有 `summaryAction` 通道
  （与 Agent 工具行、`WorkflowToolSummary`、ListPlans 同款）：
  `role="button"` + `aria-label`（含目标标题）+ `testId`，整行动词打开右侧 tab。
- 展开/收起取舍：`ToolLayout` 里 `summaryAction` 与展开互斥（有 action 即不渲染
  展开内容，这是 Agent 行的既有做法，本需求不为 SendMessage 开特例分支）。
  因此收件人会话可解析的 SendMessage 行不再提供摘要/正文的展开入口，
  点击整行即去右侧——已成功投递的行，其消息已在子代理 transcript 里，
  正文不丢失。失败/取消态的行点进去看到的是收件人会话本身，
  但不含这条未投递的消息（transcript 里没有它）。
  收件人会话不可解析（无 childSessionId / 历史缺口）的行**保持可展开**，
  摘要与正文仍在本行展开区可读。
- 显示安全：标题只用 `agentTitleByIdentity` 的可见标题或 `subagentType`，
  内部 `agent_<uuid>` 永不外露（沿用 SendMessage 现有 fallback 规则）。
- Desktop continuous 与 Web/手机 replayable 继续使用既有 snapshot/delta 通道；
  本功能不新增队列、ACK、远端状态或协议字段（`packages/shared` 仅新增 test id 常量）。
- 遥测：打开动作经 `runUserAction({ featureId: "conversation.subagent",
  action: "open_side_pane", trigger: "button" })` 上报，与 Agent 行同一口径。

## 接口与不变量

- `buildAgentSessionByIdentity(rows: readonly ConversationRow[])`
  （`conversationAssistantWorkItems.ts`，与 `buildAgentTitleByIdentity` 同源同形，
  消费同一批已加载会话行的 SubagentRow 投影）：`ReadonlyMap<string, { childSessionId: string;
  subagentType: string }>`；配套 `buildAgentSessionByIdentityMemo()` 复用
  `RowsTitleIndexMemo`（行对象引用判据 + 会话切换 `clear()`）。
  注意与标题索引的区别：标题需要 Agent 行配对（`pairSubagentRows`，标题取自配对的
  Agent 工具行），会话身份不需要配对——SubagentRow 自带 `childSessionId` 与
  `subagentType`，逐行直取即可。
- `buildRunningSubagentSessionByIdentity(running: readonly RunningSubagentSummary[])`
  （`conversationRunningSubagentIdentity.ts`，独立成文件避免把
  `conversationAssistantWorkItems.ts` 撑过行数上限；依赖方向单一，只回引
  `AgentSessionIdentity` 类型）：把会话权威投影 `snapshot.subagents.running`
  整理成同形身份索引，键 `agentId`、值 `childSessionId` + `subagentType`；
  `agentId` 缺席的项不入索引。
- `mergeAgentSessionByIdentity(rowDerived, overlay?)`（同新文件）：行派生优先、
  overlay 只补缺的纯合并；overlay 缺席或为空时原样返回 rowDerived（保持
  `RowsTitleIndexMemo` 的引用复用）。
- `ConversationRowRenderContext.agentSessionByIdentity?`（`conversationRowContext.ts`，
  renderer 只读，引用需保持稳定；消费方看到的已是合并结果）。
- `ConversationRowRenderContext.runningSubagentSessionByIdentity?`（同文件，
  renderer 只读）：快照 running 补位索引，SessionPane 构造、仅 ConversationTimeline
  消费合并，不直接下发到行。
- `ToolCallBlock` 不新增 props：复用既有 `agentSummaryAction` 透传
  （`ToolCallBlocks.tsx` 已有，子工具卡不继承，天然无泄漏）。
- `SendMessageToolCallBlock` 消费 `context.agentSummaryAction`，与 `agent.tsx`
  的 `summaryAction` 构造同形（`ariaLabel` 含目标标题）。
- 新增 test id：`TID_V4_SEND_MESSAGE_OPEN_SIDE_PANE = "v4-send-message-open-side-pane"`
 （动态后缀为 `childSessionId`），与 `TID_V4_SUBAGENT_OPEN_SIDE_PANE` 同目录。
- 新增 i18n：`chat.toolCall.sendMessage.openInSidePane`（含 `{title}` 插值），中英双语。

## 负面边界（不做什么）

- 不新增外壳主视图档位、路由或窗口覆盖层：落点复用 `sidePane` 内
  `subagent-session` tab。本需求不把发送消息改到文件主视图；文件主视图见 `workspace-files.md`。
- 不动子代理面板底部状态条的可交互性：`subagent-status-footer.md` 的三项不可交互，
  那是面板 footer，不是本需求的主对话流行。
- 不另造写入路径或第二个状态所有者：打开走现有 `handleOpenSubagentSession` /
  `openSubagentSessionSidePane`，不直接调平台 API。
- 不改 `ToolLayout` 的 action/展开互斥语义，不为 SendMessage 开特例分支。
- 不用 CDP 操作 YCode。

## 验收场景

1. 主对话流中「已发送 给 XXX」行（目标子代理已 spawn、有 childSessionId）：
   整行可点（`role="button"`，`data-testid="v4-send-message-open-side-pane-<childSessionId>"`，
   aria 含目标标题）；点击后右侧出现/聚焦 `subagent-session` tab，标题与行上标题一致；
   重复点击只聚焦，不新增副本。
2. 目标子代理尚无 childSessionId（未 spawn 或历史缺口）：该行保持现状——不可点、
   可展开看摘要/正文，不报错，无 console 异常。
3. 同一轮内「子智能体」行与「已发送」行并存、子智能体仍在运行时：
   「已发送」行同样可进入侧边视图（工具调用状态不参与判定）。
4. 只读/分享视图：SendMessage 行无可点入口（宿主不注入回调），保持现状。
5. 流式参数未完整（`to` 还没到）：无入口；参数到齐后出现入口，不闪烁报错。
6. 切换语言到 English：aria-label 为英文，无未翻译 key 字面量。
7. 远程 workspace：打开请求带 `workspaceIdentity` + `remoteSessionId`，
   tab 按 workspace 隔离，不串到本地同名会话。
8. 窗口截断/冷恢复补位：目标子智能体仍在运行、但其 SubagentRow 已不在已加载
   行窗口里（长会话早期 spawn），「已发送」行仍可点、点击打开正确的
   childSessionId——身份来自 `snapshot.subagents.running` 补位，不要求用户先
   回滚历史把行加载进窗口。
9. 行派生与快照冲突时以行为准：同一 `agent_<uuid>` 同时存在于行窗口与
   running 投影时，采用行派生的 childSessionId/subagentType（合并只补缺不覆盖）。
10. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；
   `packages/ui` 相关测试通过。
