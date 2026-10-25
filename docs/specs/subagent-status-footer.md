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
- **上下文明细与缓存命中率同样由子会话自己的轮次生产**（生产侧要求）：
  子会话的 `ModelComplete` 除水位外，还要携带 `contextUsageBreakdown`
  （按来源的 tokens/chars 明细）与 `cacheHit`（缓存命中率快照）。
  缺这两项时子代理浮层只剩"容量标题 + 单色进度条"，与主会话输入框浮层的
  "来源明细 + 平均缓存命中率"不一致，等于把子代理的上下文占用讲成了一团黑。
  子会话 runtime 是独立实例（`runtime.config.taskType === "subagent_child"`），
  缓存命中率聚合只统计子会话自己的请求；父会话的缓存统计不受子会话影响。
- **明细字段按字段级合并，不整体覆盖**：投影收到 `ModelComplete` 时，
  新的 `contextWindow` 缺少 `breakdown` 或 `cache` 时保留上一次的值，
  只有新事件真正带来该字段才替换。某一轮没带明细就清空整段明细，
  等于让浮层内容随"这轮事件带了哪些字段"抖动。
- **分母未知时保持未知**：子会话模型的 `contextWindow` 未声明（或 registry 显式清除
  为 null）时，快照 `usage.contextWindow` 保持 `null`，Footer 显示空圆环，
  hover 说明暂无子会话用量；不得伪造默认窗口、不得回退父会话分母。
- **用量尚未产生或无效时仍显示入口**：Footer 的上下文圆环始终显示并可 hover/点击；
  `used<=0` 或 `size<=0` 时显示空圆环和本地化的无用量说明，不显示百分比、分解明细、
  套餐额度或虚构的 0/总量。有效用量才显示容量摘要、进度、可用来源明细与缓存命中率。
- 状态条是纯消费叶子：不持有状态、不写 composer draft、不发起额度或网络请求；
  hover 明细只读快照里的 `breakdown`，不触发 access 刷新。
  子会话没有独立账户额度数据，因此无用量空态不复用 Input 的账户额度区。

空态展示决策：Input 在尚未发送消息时仍可展示账户额度，是因为 Composer 拥有额度查询配置；
Subagent Footer 只持有子会话快照，不能安全地展示父级账户额度。故无数据时保留相同的
圆环入口和浮层交互，但浮层明确说明尚无子会话用量，不伪造数据，也不请求账户额度。

事件顺序（无新增异步状态）：

```text
子会话 snapshot → Footer 按 sessionId 验证身份 → 有效用量显示详情 / 无效或缺失显示空态
                                                   ↘ 圆环 hover/点击打开只读 HoverCard
```

- 子会话 `config.mode` 的唯一权威来源是**该子 runtime 自身持久化的 `permission.mode`**，不是父会话 mode，也不是代理类型推断。detached child 没有独立 bootstrap record，因此首次创建和冷恢复均由 hydration 从 child session store 读取该值，并通过 `SessionConfigSeed.mode` 注入自己的 publisher。
- 新 child 在 `notifySessionReady` 前完成 session 持久化；打开子会话时先完成 hydration，再向订阅者提供快照。hydration 种子只补事件未触碰的字段；已有 `SessionModeChanged` 日志值优先，不能通过初始化伪造“用户切换模式”事件。
- Desktop continuous 与 Web/手机 replayable 继续使用既有 snapshot/delta 通道；本功能不新增队列、ACK、远端状态或协议字段（`packages/shared` 类型无需变）。

```text
child runtime → 持久化 permission.mode → detached hydration 读取 child session
             → publisher.seedConfig（事件未触碰时）→ child snapshot → Footer
```

冷恢复边界：旧 child 有 `permission.mode` 时以其补齐无模式事件的快照；日志中存在模式事件时日志值优先；store 无 child 记录或无有效模式时不借用父会话值，保留既有快照 fallback。

## 产品规则

- 子代理只读面板底部有一条高 `h-8` 的常驻行（`shrink-0`，flex 列里 timeline 之下，
  不参与滚动、不随流式内容变化），三项从左到右为：工作模式徽标、
  模型名（+ 思考档位裸词后缀）、上下文用量。上下文触发格仅显示与 Input 同尺寸的圆环，
  不显示百分比文字；因圆环占用空间超过原 footer 高度，行高调整为 `h-8`。
  hover 详情复用与输入框 `ChatContextUsage` 同一个纯展示组件（容量标题、摘要、分段进度条、
  来源明细、缓存命中率），不允许维护两套视觉实现。输入框额度刷新/运营提示等交互仍由
  `ChatContextUsage` 自己拥有。
- 模式与模型信息不可交互；上下文圆环使用 Input 同款按钮触发器，点击或触摸打开只读详情，
  不修改 draft、不触发额度或 access 请求。有效用量显示容量标题、摘要、进度和已有来源明细；
  无有效用量时只显示本地化的"暂无子会话用量"说明，不显示账户额度或伪造的容量数字。
  有用量时，来源明细与平均缓存命中率必须出现（数据缺失时显示的是数据缺口，
  不是"子代理没有明细"）；显示项、顺序、格式与输入框浮层逐项一致。
- 模式名映射 `plan→Plan、readonly→Ask、yolo→Agent、bare→Bare`
  （与 `normalizeAvailableZCodeMode` 的归一口径一致，未知值回退 Agent）；
  档位色走 `resolveModeOptionToneClass`（`--color-mode-*` 身份色，不表达风险）；
  模型名经 `formatModelDisplayName` 排版，`truncate` 收敛，不挤压上下文格；
  思考档经 `thoughtLevelLabelId` 查词表后作为裸档位词展示（`high`→"· 高"，
  去掉"思考"二字、保留间隔点 `·` 分隔，避免"思考 中"误读为进行中），
  表外值原样显示 provider 自己的档位名。
- 窄宽度**分级降级**（container query，无 JS 宽度感知）：
  宽度充足时三项全显；`≤320px` 先隐去「模型 + 思考深度」；
  `≤220px` 再隐去「工作模式」；「上下文用量」只占一个圆环，始终显示，不设降级档。
  判定依据：典型侧栏宽 320~400px；320px 下三格挤作一团
  （模型名截断到只剩两三个字），先砍最宽的模型格；220px 下模式徽标也需要降级，
  再砍模式格。
- 用量有效性与输入框沿用同一门控口径（`getRenderableTaskUsage`）：
  `used<=0` 或 `size<=0` 时圆环入口仍显示，但使用空环并在浮层说明暂无子会话用量；
  不得渲染 `0%`、`0/总量` 或"上下文 --"替代可交互入口。
- "滚动到底部 / 回到最新"圆钮挂在 timeline 根的 `absolute bottom-3`，
  天然落在常驻 footer 之上，不重叠；不得改动 `shouldShowBackToBottom`、
  `resolveFollowingAfterScroll` 等滚动跟随语义。
- **只读面板底部不预留 composer 遮挡带**：消息层底部遮罩（`ConversationTimeline`
  的 `syncMessageLayerMask`）是为 sticky composer dock 的透明留白服务的——dock 自身
  的 padding 是透明的，消息会从留白透出来，遮罩把那一段渐隐掉；全透明的 96px 留白
  正好盖住 dock 的透明 padding，24px 渐隐区负责过渡。
  只读面板（子代理详情、WorkflowActor 等）没有 composer dock（`readOnly ? null`
  整段掐掉 dock），底部没有任何东西遮挡正文，这条遮挡带就退化成一段 120px 的死区：
  正文被裁成空白，下面留出一截与内容无关的空隙，悬浮圆钮孤零零地落在空白中央。
  **没有 composer dock 时不施加遮罩**：正文连续显示到面板底部，圆钮以不透明卡片底
  浮在正文之上（与主会话里圆钮浮在 composer 上方的既有形态一致）。
  视口比遮挡带还矮（< 96px）时渐变会退化成「整屏全透明」——正文整屏消失。
  这种视口下 composer 本身已无处安放，直接不遮罩（宁可完全不遮罩，也不让正文消失）。

## 接口与不变量

- `SessionPane` 新增可选 prop `readOnlyStatusFooter?: boolean`（默认 `false`；
  `SessionPane.tsx:319` 声明、`541` 解构、`5561` 渲染）。
  生效门是 `SubagentSessionSidePane` 显式下发（`SubagentSessionSidePane.tsx:47`），
  不按 `readOnly` 或 `openTrigger` 字符串隐式判断。
- 状态条组件 `packages/ui/src/v4/SubagentStatusFooter.tsx` 的导出：
  `SubagentStatusFooter`（`{ snapshot, sessionId }`）、
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
- **不在 footer 复用 `ChatContextUsage` 本体**：它内部挂 `useOptionalTabStore`、
  `useCodingPlanQuotaResetUi`（含 entitlement / access 刷新副作用）与额度面板 props，
  在只读 footer 里挂它会把额度请求带进只读场景。两处改为共用无副作用的
  `ContextUsageTrigger` 与 `ContextUsageDetails`；`ChatContextUsage` 继续独占额度刷新、
  运营提示和额度面板编排。
- **详情渲染只有一份实现**：输入框 `ChatContextUsage` 与状态条 Footer 都渲染
  同一个 `ContextUsageDetails`（`packages/ui/src/chat-input-toolbar/ContextUsageDisplay.tsx`），
  容量标题、摘要、分段进度条、来源明细、缓存命中率全部由它产出。
  输入框不得再保留第二份手工渲染（否则两边的明细顺序、颜色分段和文案会各自漂移）。
  输入框的账户额度面板仍然只属于 `ChatContextUsage`，不属于上下文详情，两边都不共享。
- **排序只有一份实现**：明细展示顺序（chars 降序，tie 按来源固定序）住在
  `packages/ui/src/lib/contextUsageBreakdown.ts` 的
  `sortContextUsageBreakdownSegments`；输入框与状态条均经 `ContextUsageDetails`
  使用它，不得再出现第二份排序代码。
- i18n key（中英文两份，文案一律 `intl.formatMessage`）：
  `subagentStatusFooter.mode` / `.thoughtSuffix` /
  `.contextUsageUnavailable`
  （`packages/ui/src/i18n/locales/zh-CN.ts:730` 起、`en-US.ts:794` 起）；
  另复用 `chat.contextUsage` / `.title` / `.breakdown*`。
- 测试锚点：根 `data-testid="subagent-status-footer"`，
  `data-subagent-footer-mode / -provider / -model / -thought / -usage-used / -usage-max`
  （与 `V4ComposerToolbar` 的隐藏 span 同风格）。
- 消息层底部遮罩的几何裁决收敛到纯函数模块
  `packages/ui/src/v4/timelineMessageMask.ts`：
  `resolveTimelineMessageMask({ atBottom, viewportHeight, hasComposerDock, layerTopOffsetPx })`
  返回 `null` 表示不施加遮罩（`mask: none`），返回遮罩样式时含
  `maskImage / maskPosition / maskSize` 三项。
  尺寸常量 `TIMELINE_MESSAGE_MASK_FADE_PX`（24）与
  `TIMELINE_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX`（96）由该模块导出，
  `ConversationTimeline` 不再自带副本。
  **遮罩的存在与否由 `bottomDock` 决定，不新增 prop**：`bottomDock` 本来就表达
  "这个面板有没有 composer dock"，`Boolean(bottomDock)` 即门控信号；它是布尔量，
  放进 `useCallback` 依赖不会让滚动回调每帧换引用。

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
- 不改主会话（有 composer dock）的遮挡带几何：dock 存在时，正常视口高度下
  遮罩与改动前逐像素一致（唯一例外是视口 < 96px 的退化情形，见产品规则）。
- 不为"没有 composer 也要淡出"引入新的魔数：没有遮挡物就不遮罩，遮挡带只服务 dock。

## 验收场景

SSR 单测已覆盖（`packages/ui/test/subagentStatusFooter.test.ts`，9 项用例、
覆盖下列断言场景，其中"分级降级"一个用例承载场景 4 与 5；
`packages/ui/test/contextUsageBreakdown.test.ts` 的排序与分段行为继续由共享组件复用）：

1. 子快照取值正确：mode/model/thought/usage 四个锚点都落在子快照的值上
   （plan→Plan 显示名、`high`→"· 高"裸档位后缀）。
2. 身份错配不回退父值：`snapshot.sessionId !== sessionId` 时 mode 回退 yolo、
   model 与 usage 锚点为空。
3. `used<=0 || size<=0`、快照缺失或身份错配时仍显示按钮与空圆环；hover 显示本地化的
   暂无子会话用量，不显示 `0%`、容量数字或父会话数据。
4. 降级按序生效且各格挂对降级类：模型格含 `@max-[320px]` 且不含 220 档、
   模式格含 `@max-[220px]` 且不含 320 档、容器名后缀逐一等于
   `SUBAGENT_FOOTER_CONTAINER`。
5. 上下文格不含任何 `@max-`，常驻显示。
6. 上下文圆环使用可点击按钮打开只读详情；footer 不渲染 `select` / `input` / `a` 等会修改配置或离开当前面板的控件。
7. Footer 通过自身 HoverCard 展示共享的只读详情组件；SSR 验证触发器仅含圆环且不含百分比，
   明细来源与缓存命中率按当前 locale 展示。排序由共享组件调用
   `sortContextUsageBreakdownSegments`，与输入框保持一致。

投影回归（`apps/zcode-cli/packages/bootstrap/test/`，走 `ProductProjection.applyEvent`）：

8. 子会话 `ModelComplete(querySource="subagent")` 之后，子会话快照
   `usage.contextWindow.usedTokens` 为该轮真实水位（与主会话同一
   `getModelUsageContextTokens` 口径），footer 可渲染对应比例的圆环。
9. 子会话事件不污染父会话：隔离由路由层保证——子事件按自身 `sessionId`
   经 detached 通道进入子会话自己的投影（`server-operations.ts:3099-3110`、
   `v4-gateway.ts:1130`），父镜像只转发 ToolCall/Permission 类事件、不含
   `ModelComplete`（`tool-event-mirror.ts:19-31`），父投影根本不会收到子会话
   的 `ModelComplete`；父快照仍只由 `main_turn` 轮次写入。
10. 缺分母时保持未知：`ModelSelected`/`ModelComplete` 均未声明 `contextWindow`
    时，快照 `usage.contextWindow` 为 `null`，不得伪造默认窗口。
11. detached Explore 子会话首次投影从 child 持久化 `permission.mode` 注入 `readonly`，底栏显示 Ask；不读取父会话 mode。
12. 冷恢复无模式事件时由持久化模式种子补齐；若事件日志已有 `SessionModeChanged`，日志 mode 优先于种子。
13. store 无 child session 或无有效权限模式时不回退父会话值，保留既有快照兼容行为。

生产侧回归（`apps/zcode-cli/packages/core/test/`）：

14. 子会话轮次（`querySource="subagent"`）发出的 `ModelComplete` 载荷携带
    `contextUsageBreakdown` 与 `cacheHit`；`querySource="main_turn"` 行为不变。
15. 子会话缓存命中率聚合只统计子会话自己的请求，不写父会话口径。

投影字段级合并回归（`apps/zcode-cli/packages/bootstrap/test/`）：

16. 子会话快照在后续轮次未携带 `breakdown` / `cache` 时保留上一轮的值，
    不被整体覆盖清空；新事件真正带来该字段时才替换。

UI 一致性回归（`packages/ui/test/`）：

17. 输入框浮层与子代理 Footer 浮层都渲染 `ContextUsageDetails`：
    相同 `used/max/breakdown/cache` 输入下，两边的标题、摘要、进度分段、
    来源明细行与缓存命中率逐项一致（同一组件、同一排序）。
18. 消息层底部遮罩的几何裁决（`packages/ui/test/timelineMessageMask.test.ts`）：
    - 无 composer dock → 不施加遮罩（返回 `null`），不预留任何遮挡带；
    - 有 composer dock 且已贴底 → 不施加遮罩；
    - 有 composer dock 且离底 → 遮挡带几何与改动前一致
      （96px 全透明 + 24px 渐隐，渐变与位置随滚动视口对齐）。

仍需真人肉眼在真实窗口验证（SSR 覆盖不到）：

8. 拖动侧栏宽度经过 320px / 220px 时，模型格、模式格确实按序消失与恢复，
   且阈值处无布局抖动。
9. "滚动到底部"圆钮与状态条的间距：不重叠、不遮挡，可点中。
10. 上下文 hover 浮层（`!w-80`）在窄侧栏下不被裁切到不可读。
11. 其他只读面板（WorkflowActor、Selection）不出现该状态条：
    静态已确认（全仓 `grep readOnlyStatusFooter` 仅 `SubagentSessionSidePane`
    一处传参），运行时抽检打开对应面板确认底部无该行即可。
12. 中/英文切换无未翻译 key 字面量。
13. 子代理面板滚离底部：正文连续显示到面板底部，不再有底部空白带；
    正文末行不再被渐隐裁掉；圆钮仍浮在正文之上、可点中。
14. 主会话滚离底部：composer 上方的遮挡带与改动前一致，正文仍在 dock 上方渐隐，
    不透出 dock 的透明留白。
