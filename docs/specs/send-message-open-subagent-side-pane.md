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
  → ConversationTimeline memo 缓存（RowsTitleIndexMemo，行对象引用判据）→ renderRowContext
  → ConversationTurnGroup（缺席时按本轮 rows 回退构建）
  → ConversationRowRenderContext.agentSessionByIdentity（renderer 只读）
  → ToolCallRowView：SendMessage 行按 input.to 查表 + 绑定会话 scope，产出 agentSummaryAction
  → ToolCallBlock → SendMessageToolCallBlock → ToolLayout summaryAction（整行可点）
  → context.onOpenSubagentSession → SessionPane.handleOpenSubagentSession（补 workspace 身份）
  → useAppPanels.handleOpenSubagentSession → openSubagentSessionSidePane（幂等聚焦）
```

- 身份唯一来源是**已加载会话行中的 SubagentRow 投影**：`childSessionId` 必须来自
  `SubagentRow.childSessionId`，`subagentType` 来自 `SubagentRow.subagentType`，
  键是 `SubagentRow.entityId`（与 SendMessage `input.to` 的 `agent_<uuid>` 同源）。
  **禁止**用字符串拼接（`sess_subagent_<agentId>` 之类）推导会话 id。
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

- 可打开条件（六者齐备才整行可点，缺一即回退现状）：
  1. 该 SendMessage 行经 `normalizeZCodeToolName` 归一后为 `SendMessage`
     （与渲染分派 `resolveRenderer.ts:179-181` 同一口径）；
  2. 适配后工具 input 的 `to` 非空（与 `SendMessageToolCallBlock` 的读取同源；
     v4 行的 raw 从不携带 input 记录，桥接只写 error/output/display，input 唯一
     通道是 `row.input` / `inputText` 流式预览）；
  3. `agentSessionByIdentity.get(to)` 命中且含 `childSessionId`；
  4. 该行 `row.status === "success"`（已投递）；
  5. 当前 `context.sessionId` 存在（作为 `parentSessionId`）；
  6. 宿主注入了 `context.onOpenSubagentSession`。
- 整行可点 = 打开侧边视图，走 `ToolLayout` 既有 `summaryAction` 通道
  （与 Agent 工具行、`WorkflowToolSummary`、ListPlans 同款）：
  `role="button"` + `aria-label`（含目标标题）+ `testId`，整行动词打开右侧 tab。
- 展开/收起取舍：`ToolLayout` 里 `summaryAction` 与展开互斥（有 action 即不渲染
  展开内容，这是 Agent 行的既有做法）。因此**仅已投递成功（`success`）且可打开的
  SendMessage 行不再提供摘要/正文的展开入口**，点击整行即去右侧——消息已在子代理
  transcript 里，正文不丢失。失败/取消/拒绝/停止（消息从未投递，transcript 里没有）
  与进行中（投递未落定）的行**保持可展开**，摘要与正文仍在本行展开区可读。
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
- `ConversationRowRenderContext.agentSessionByIdentity?`（`conversationRowContext.ts`，
  renderer 只读，引用需保持稳定）。
- `ToolCallBlock` 不新增 props：复用既有 `agentSummaryAction` 透传
  （`ToolCallBlocks.tsx` 已有，子工具卡不继承，天然无泄漏）。
- `SendMessageToolCallBlock` 消费 `context.agentSummaryAction`，与 `agent.tsx`
  的 `summaryAction` 构造同形（`ariaLabel` 含目标标题）。
- 新增 test id：`TID_V4_SEND_MESSAGE_OPEN_SIDE_PANE = "v4-send-message-open-side-pane"`
 （动态后缀为 `childSessionId`），与 `TID_V4_SUBAGENT_OPEN_SIDE_PANE` 同目录。
- 新增 i18n：`chat.toolCall.sendMessage.openInSidePane`（含 `{title}` 插值），中英双语。

## 负面边界（不做什么）

- 不新增外壳主视图档位、路由或窗口覆盖层：落点复用 `sidePane` 内
  `subagent-session` tab（`workspace-shell-primary-tabs.md` 仍只有 `tasks|settings` 两档）。
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
3. 只读/分享视图：SendMessage 行无可点入口（宿主不注入回调），保持现状。
4. 流式参数未完整（`to` 还没到）：无入口；参数到齐后出现入口，不闪烁报错。
5. 切换语言到 English：aria-label 为英文，无未翻译 key 字面量。
6. 远程 workspace：打开请求带 `workspaceIdentity` + `remoteSessionId`，
   tab 按 workspace 隔离，不串到本地同名会话。
7. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；
   `packages/ui/test/taskOutputRender.test.ts` 新增用例通过。
