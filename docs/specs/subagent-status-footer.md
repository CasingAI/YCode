# Spec: 子代理面板底部常驻只读状态条

## 背景与目标

子代理侧边面板（`subagent-session` tab，经 `SubagentSessionSidePane` 渲染只读
`SessionPane`）底部原来只有一条窄带，带内居中显示"滚动到底部"下箭头；
只读时 composer dock 被 `readOnly ? null` 整段掐掉，底部是空位。
本次在该空位放一条常驻 footer，显示三项只读信息：
工作模式（Plan / Ask / Agent / Bare）、当前模型与思考深度（只读）、
上下文用量（与输入框 Input 上的上下文组件同一口径）。

模板与深度标准参照 `docs/specs/subagent-directory-side-pane.md`（子智能体目录）。
与目录面板的关系：目录是启动器与列表面，本状态条是详情面板
（`subagent-session` tab）底部的常驻信息行，两者并存，互不改动。

## 状态所有者与数据流

```text
CLI V4 projection snapshot（子会话自己，sessionId = tab.childSessionId，唯一权威）
  → SessionPane 经 useConversationProjection(lease) 读取 snapshot
  → SubagentStatusFooter 只读消费 snapshot.config / snapshot.usage
  → 底部常驻行（纯展示，不持有状态）
```

- 数据唯一来源是**子会话自己的快照**：`snapshot.config.{mode,provider,model,thought}`
  与 `snapshot.usage.contextWindow.{usedTokens,maxTokens}`。
  `SessionPane` 的 snapshot 已按 `lease(sessionId=childSessionId)` 投影，
  组件内再按 `snapshot.sessionId === sessionId` 校验（`ownSnapshot`），
  身份不对直接按空态处理。
- **身份不一致时显示空态、绝不回退父会话数值**：父会话用量口径只统计父会话自身，
  把父会话的用量/模型贴到子代理行上是语义错误（用户会误以为子代理烧了父会话的量，
  或反之），所以宁可显示"上下文 --"占位，也不拿任何其他会话的值来填。
- **子会话快照的用量由子会话自己的轮次生产**（生产侧要求）：
  子会话 runtime 每轮结束发出 `ModelComplete(querySource="subagent")`；
  V4 投影的每个会话有独立实例（按 `sessionId` 路由，子事件经 detached 通道进入子会话
  自己的投影），该事件必须把 `usedTokens`（与主会话同一口径
  `getModelUsageContextTokens`）写进**事件所属子会话自己**的快照
  `usage.contextWindow`。父会话快照仍只由 `querySource="main_turn"` 的轮次写入，
  子会话事件不得污染父会话水位。
- **分母未知时保持未知**：子会话模型的 `contextWindow` 未声明（或 registry 显式清除
  为 null）时，快照 `usage.contextWindow` 保持 `null`，footer 继续显示
  "上下文 --"占位，不得伪造默认窗口、不得回退父会话分母。
- 状态条是纯消费叶子：不持有状态、不写 composer draft、不发起额度或网络请求；
  hover 明细只读快照里的 `breakdown`，不触发 access 刷新。
- Desktop continuous 与 Web/手机 replayable 继续使用既有 snapshot/delta 通道；
  本功能不新增队列、ACK、远端状态或协议字段（`packages/shared` 类型无需变）。

## 产品规则

- 子代理只读面板底部有一条高 `h-7` 的常驻行（`shrink-0`，flex 列里 timeline 之下，
  不参与滚动、不随流式内容变化），三项从左到右为：工作模式徽标、
  模型名（+ 思考档位裸词后缀）、上下文用量（右对齐 `ml-auto`，小圆环图标 + 百分比）。
- 三项**均不可交互**：不响应点击、不打开下拉、不写 draft。
  上下文这一格传 `span` 孩子给 `ContextTrigger`，避免其默认渲染 `<button>`；
  hover 明细（容量标题 + 进度条 + 来源分段）保留，点击无任何动作。
- 模式名映射 `plan→Plan、readonly→Ask、yolo→Agent、bare→Bare`
  （与 `normalizeAvailableZCodeMode` 的归一口径一致，未知值回退 Agent）；
  档位色走 `resolveModeOptionToneClass`（`--color-mode-*` 身份色，不表达风险）；
  模型名经 `formatModelDisplayName` 排版，`truncate` 收敛，不挤压上下文格；
  思考档经 `thoughtLevelLabelId` 查词表后作为裸档位词展示（`high`→"· 高"，
  去掉"思考"二字、保留间隔点 `·` 分隔，避免"思考 中"误读为进行中），
  表外值原样显示 provider 自己的档位名。
- 窄宽度**分级降级**（container query，无 JS 宽度感知）：
  宽度充足时三项全显；`≤320px` 先隐去「模型 + 思考深度」；
  `≤220px` 再隐去「工作模式」；「上下文用量」占用极小，始终显示，不设降级档。
  判定依据：典型侧栏宽 320~400px；320px 下三格挤作一团
  （模型名截断到只剩两三个字），先砍最宽的模型格；220px 下连
  「模式徽标 + 百分比」（约 160px + padding）都放不下，再砍模式格。
- 用量门控与输入框同一口径（`getRenderableTaskUsage`）：
  `used<=0` 或 `size<=0` 时隐藏用量格、显示"上下文 --"占位，
  不得渲染 `0%` 之类的假数据。
- "滚动到底部 / 回到最新"圆钮挂在 timeline 根的 `absolute bottom-3`，
  天然落在常驻 footer 之上，不重叠；不得改动 `shouldShowBackToBottom`、
  `resolveFollowingAfterScroll` 等滚动跟随语义。

## 接口与不变量

- `SessionPane` 新增可选 prop `readOnlyStatusFooter?: boolean`（默认 `false`；
  `SessionPane.tsx:319` 声明、`541` 解构、`5561` 渲染）。
  生效门是 `SubagentSessionSidePane` 显式下发（`SubagentSessionSidePane.tsx:47`），
  不按 `readOnly` 或 `openTrigger` 字符串隐式判断。
- 状态条组件 `packages/ui/src/v4/SubagentStatusFooter.tsx` 的导出：
  `SubagentStatusFooter`（`{ snapshot, sessionId }`）、
  `resolveSubagentFooterBreakdown(breakdown, usedTokens)`（聚合 + 展示排序的
  组合管线，组件与单测共用同一函数）、
  `SUBAGENT_FOOTER_CONTAINER = "subagent-footer"`、
  `SUBAGENT_FOOTER_TEST_IDS`。
- 容器查询契约：根 `@container/subagent-footer`，模型格
  `@max-[320px]/subagent-footer:hidden`，模式格
  `@max-[220px]/subagent-footer:hidden`。三处 class 刻意保留完整字面量、
  不做模板拼接：Tailwind 靠扫描源码整串类名生成 CSS，拼出来的串扫不到，
  样式会静默丢失；改名时三处同改，单测按常量逐一校验后缀，错配即红。
- 复用的纯函数清单（只复用纯函数，不复用交互控件
  `ModelConfigSelect` / `ThoughtLevelCycleControl` / `V4ComposerModeControls`，
  它们会写 draft）：`getRenderableTaskUsage`（门控）、
  `formatContextUsageSummary` / `formatContextUsageBreakdownLabel`（文案）、
  `buildContextUsageBreakdownSegments`（聚合）、`sortContextUsageBreakdownSegments`
  （展示排序）、`getZCodeAgentAvailableModes`（模式名）、
  `resolveModeOptionToneClass`（档位色）、`formatModelDisplayName`（模型名）、
  `thoughtLevelLabelId`（思考档词表）。
- **不复用 `ChatContextUsage` 本体**：它内部挂 `useOptionalTabStore`、
  `useCodingPlanQuotaResetUi`（含 entitlement / access 刷新副作用）与 7 路额度
  面板 props，在只读 footer 里挂它会把额度请求带进只读场景。
  明细来源标签与其内部 `BREAKDOWN_SOURCE_LABEL_ID` 同一套i18n key，
  两处说同一个词。
- **排序只有一份实现**：明细展示顺序（chars 降序，tie 按来源固定序）住在
  `packages/ui/src/lib/contextUsageBreakdown.ts` 的
  `sortContextUsageBreakdownSegments`；输入框 `ChatContextUsage` 与本状态条
  （经 `resolveSubagentFooterBreakdown`）共用它，不得再出现第二份排序代码。
- i18n key（中英文两份，文案一律 `intl.formatMessage`）：
  `subagentStatusFooter.mode` / `.thoughtSuffix` /
  `.contextUsageUnavailable` / `.contextUsageUnavailableShort`
  （`packages/ui/src/i18n/locales/zh-CN.ts:730` 起、`en-US.ts:794` 起）；
  另复用 `chat.contextUsage` / `.title` / `.breakdown*`。
- 测试锚点：根 `data-testid="subagent-status-footer"`，
  `data-subagent-footer-mode / -provider / -model / -thought / -usage-used / -usage-max`
  （与 `V4ComposerToolbar` 的隐藏 span 同风格）。

## 依赖方向与边界

- 状态条不得引入 UI→Repo/Service 直连，不得新增状态所有者或第二条写入路径；
  模式/模型/思考三项只读快照的 effective 投影，不读、不写 composer draft。
- `SessionPane` 其他调用方行为不变：`V4ChatPane`（workspace-main）、
  `WorkbenchPane`（sidebar/split）、`WorkflowActorSessionSidePane`（只读，不开门）、
  `SelectionSideChatPane`（selection，不开门）均不传 `readOnlyStatusFooter`。
- 字体只用 `text-ui-*`，颜色只用语义 token；不挪用 `--color-success` 等语义色，
  模式色只用 `--color-mode-*`。

## 负面边界（不做什么）

- 不改父会话 composer、不改协议契约、不改滚动跟随语义。
- 不为 footer 触发额度请求或引入新的网络/hover 刷新副作用。
- 不动 `ChatContextUsage` 的额度面板行为；排序收敛时不改变
  `buildContextUsageBreakdownSegments` 本体的返回顺序
  （其既有单测依赖 Map 首次出现顺序，排序是展示层职责）。
- 不动另外两个只读调用方（WorkflowActor、Selection）的面板行为。

## 验收场景

SSR 单测已覆盖（`packages/ui/test/subagentStatusFooter.test.ts`，6 项用例、
覆盖下列 7 条断言场景，其中"分级降级"一个用例承载场景 4 与 5；
`packages/ui/test/contextUsageBreakdown.test.ts` 既有 10 项不受影响）：

1. 子快照取值正确：mode/model/thought/usage 四个锚点都落在子快照的值上
   （plan→Plan 显示名、`high`→"· 高"裸档位后缀）。
2. 身份错配不回退父值：`snapshot.sessionId !== sessionId` 时 mode 回退 yolo、
   model 与 usage 锚点为空。
3. `used<=0 || size<=0` 时用量格隐藏、显示"上下文 --"，不渲染 `0%`。
4. 降级按序生效且各格挂对降级类：模型格含 `@max-[320px]` 且不含 220 档、
   模式格含 `@max-[220px]` 且不含 320 档、容器名后缀逐一等于
   `SUBAGENT_FOOTER_CONTAINER`。
5. 上下文格不含任何 `@max-`，常驻显示。
6. 只读无交互元素：无 `button` / `select` / `input` / `a`。
7. 明细分段顺序与输入框一致：调组件实际使用的
   `resolveSubagentFooterBreakdown`，断言输出顺序
   `["skills", "system_tool_schemas", "messages"]`
   （chars 降序、tie 按来源固定序）。

投影回归（`apps/zcode-cli/packages/bootstrap/test/`，走 `ProductProjection.applyEvent`）：

8. 子会话 `ModelComplete(querySource="subagent")` 之后，子会话快照
   `usage.contextWindow.usedTokens` 为该轮真实水位（与主会话同一
   `getModelUsageContextTokens` 口径），footer 可渲染百分比。
9. 子会话事件不污染父会话：隔离由路由层保证——子事件按自身 `sessionId`
   经 detached 通道进入子会话自己的投影（`server-operations.ts:3099-3110`、
   `v4-gateway.ts:1130`），父镜像只转发 ToolCall/Permission 类事件、不含
   `ModelComplete`（`tool-event-mirror.ts:19-31`），父投影根本不会收到子会话
   的 `ModelComplete`；父快照仍只由 `main_turn` 轮次写入。
10. 缺分母时保持未知：`ModelSelected`/`ModelComplete` 均未声明 `contextWindow`
    时，快照 `usage.contextWindow` 为 `null`，不得伪造默认窗口。

仍需真人肉眼在真实窗口验证（SSR 覆盖不到）：

8. 拖动侧栏宽度经过 320px / 220px 时，模型格、模式格确实按序消失与恢复，
   且阈值处无布局抖动。
9. "滚动到底部"圆钮与状态条的间距：不重叠、不遮挡，可点中。
10. 上下文 hover 浮层（`!w-80`）在窄侧栏下不被裁切到不可读。
11. 其他只读面板（WorkflowActor、Selection）不出现该状态条：
    静态已确认（全仓 `grep readOnlyStatusFooter` 仅 `SubagentSessionSidePane`
    一处传参），运行时抽检打开对应面板确认底部无该行即可。
12. 中/英文切换无未翻译 key 字面量。
