# Spec: 回合过程行折叠汇总（Cursor 式过程收起）

## 目标

一个回合里连续出现的「查阅 / 终端 / 编辑 / 思考」行数量可以很大，逐条铺开会让正文被过程噪音淹没。本改动把**同一回合内连续的过程行**二次折叠成一行可展开的汇总，收起态显示一行计数：

```
查阅了 2 次 · 终端 3 次 · 编辑 1 次 · 思考 4 次
```

展开后回到改动前的那些行（查阅分组 / 终端分组 / 编辑分组 / 思考行），再展开其中某一行仍走各自原有的展开逻辑看明细 —— 两级展开。

## 产品规则

- **折叠单位是「连续过程行」**。判定与既有 `buildAssistantWorkRenderItems()` 的分组结果同源，不重新解析工具输入：
  - `exploreGroup` → 查阅
  - `executeGroup` → 终端
  - `changesGroup` → 编辑
  - `row` 且 `row.kind === "reasoning"` → 思考
  - `row` 且 `row.kind === "toolCall"` → 复用 `isExploreToolCall` / `isExecuteToolCall` / 文件写入家族（`file-write`）判定，分别归入查阅 / 终端 / 编辑
    - 「查阅」只认非 shell 的只读家族（`file-read` / `search` / `explore`）。**shell 家族一律归「终端」**，不再按命令内容把 `ls` / `grep` / `git log` 这类只读命令改判成「查阅」：卡片本身标着「终端」，汇总按另一套规则把同一行列进「查阅 N 次」，会让同一张卡出现两个类别。判定必须与卡片标签同源。
    - 命令还没到的 shell 行（`isShellToolCallAwaitingCommand`）两个桶都不进，保留为独立行。
  - 其余（`assistantText`、`artifact`、`subagent`、`hookInvocation`、`timelineMarker`、`agentToolCall`、`cuaGroup`）**不参与折叠**，照旧铺开：正文、子智能体、CUA、产物、hook 明细都不能被折进去。
- **计数口径**：分组按 `rows.length` 计（一个分组里有 3 个子工具就是 3 次），非分组行计 1。计数为 0 的桶不出现在文案里。
- **编辑走同一条路**：文件写入家族（`Write` / `Edit` 等）归入「编辑」桶。注意 `changesGroup` 由 `toolGroupingChangesEnabled` 控制（默认关闭），关闭时写入行以单行形态存在，仍会被汇总计入「编辑」——两条路径都覆盖到了，不要求用户同时打开分组开关。
- **长度不设门槛**：连续过程行即使只有 1 条也折叠成汇总（与 ZCode 侧既有行为一致），保证「过程永远只有一行」的可预期性。
- **运行中默认展开、可手动收起**：汇总位于当前工作段尾部且该段仍在运行时，默认展开，过程对用户实时可见；用户若在此时点它收起，就尊重这个选择，本段运行内不再自动弹开（流式追加的新过程行也不能把它顶开）。这一段期间的收起 / 展开都是临时态：不写展开态表，段一旦结束（或页面重载）就回到默认收起态。
  - 实现上给 `ToolLayout` 的 `forceOpen` 配 `forceOpenDismissible`（把「锁死」降级为「默认展开」），**不使用** `autoOpen` + `autoCollapseOnComplete`。后者依赖 `isRunning` 的 true→false 跳变，而回合结束时 flow item 的 key 会变化导致整个列表重挂载，模块级展开态表里被 `autoOpen` 写下的「开」会被新实例恢复，跳变却再也不会发生 → 该组永远展开。
- **行首不带类别词**：汇总行直接以计数开头（`查阅了 2 次 · 终端 3 次 · …`），不显示「过程」这类类别词——这一行的内容本身就是四类过程的计数，类别词只是重复；类别词缺席时分隔点一并省掉，避免行首留下一个孤立的「·」。
- **展开态持久化**：复用 `ToolLayout` 的模块级 `toolLayoutOpenState`（进程内、按 key），键锚定汇总的**首个子项**，因此流式追加子项时不重建组件、不丢展开态。不落 localStorage。
- **只动渲染层投影**：不改行数据、不改持久化、不改协议。`buildAssistantWorkRenderItems()` 的输入与行序不变。
- **分享只读时间线不折叠**：`ConversationShareReadonlyTimeline` 显式传 `enableTurnSummary: false`，保持既有的逐行呈现。
- 文案走 i18n（中英各一套），不硬编码中文。

## 接口

- 投影：`packages/ui/src/v4/conversationAssistantWorkItems.ts`
  - 新增导出类型 `ConversationAssistantWorkChildItem`（原 `ConversationAssistantWorkRenderItem` 的全部成员）、`ConversationTurnSummaryRenderItem`，`ConversationAssistantWorkRenderItem` 变为二者的联合。
  - 新增导出 `TurnSummaryBucket = "explore" | "terminal" | "changes" | "reasoning"`。
  - 新增常量 `ENABLE_TURN_SUMMARY = true`；`ConversationAssistantWorkRenderOptions` 新增可选 `enableTurnSummary`（缺省取常量）。
  - `buildAssistantWorkRenderItems()` 在既有分组之后做一次折叠，输出 `kind: "turnSummary"` 项：`{ key, rowId, nodes, counts, running }`。
- 渲染：`packages/ui/src/v4/ConversationTurnGroup.tsx`
  - 新增 `ConversationTurnSummaryRow`：`ToolLayout` 外壳（`forceOpen={running}` + `forceOpenDismissible`、`isRunning={running}`、`kindLabel={null}`、不传 `summaryContentSeparator`、`persistOpenKey` 加 `zc-turn-summary:` 前缀），`primaryText` 为汇总文案，内容为子项按原有 kind 分发渲染。
  - 抽出共享的 `ConversationWorkRenderItem`（kind 分发），供顶层列表与汇总内容共用，避免两处分发漂移。
  - `ConversationAssistantWorkItems` 的工作项容器不设统一 gap，纵向间距挂在每一项自己身上（`workItemGapClass`）：间距按**相邻两项的类型**给——边界任一侧是**带边框外壳的块**（渲染出来是独立盒子的那一类）就沿用收紧前的 16px，块上下两侧因此对称；两侧都不是带边框外壳的块（过程汇总行、正文行、思考行、平铺工具行）才贴紧到 2px，把连续过程连成一片；首项不加间距。容器 gap 无法区分项类型，而这两种间距需要并存，故间距放到项上。父级 flow 容器（`gap-5`）、history 折叠外壳（`pt-5`）不受影响。分享只读页不共享该容器，保持原间距。
  - 汇总展开后的子过程行同样贴紧到 2px（`TURN_SUMMARY_CONTENT_GAP_CLASS`，与外层贴紧态同一个值，只是换成 `space-y` 作用域）：收起态与展开态是同一批过程行的两种呈现，疏密必须一致。
- 间距判定：`packages/ui/src/v4/conversationWorkItemGap.ts` 导出 `isBorderedShellWorkItem`、`workItemGapClass` 与三个间距常量（`WORK_ITEM_TIGHT_GAP_CLASS` / `WORK_ITEM_CARD_GAP_CLASS` / `TURN_SUMMARY_CONTENT_GAP_CLASS`），供 `ConversationTurnGroup` 使用并单测覆盖——仓库没有 React 渲染测试基建，抽成纯函数是锁住这条规则的唯一办法。
  - 「带边框外壳」是按**渲染结果**判的，清单必须与渲染器最外层同源：`ToolLayout` 平铺行（绝大多数工具行、工具分组、子智能体、CUA 分组、`TodoWrite` 的待办行、`CreateWorkflow` 行）没有边框与背景，一律算平铺；当前算带边框外壳的只有 `switch-mode` 计划卡（且必须真的拿到了 plan markdown，否则退化成平铺输出块）、`cron-create` / `offpeak-create` 自动化卡、`resume-workflow-run` 已联接 run 时的紧凑卡。新增带边框外壳的卡片渲染器时要同步登记，否则它的上下间距会退回 2px 贴平。
- 外壳能力：`packages/ui/src/ToolCallBlocks/ToolLayout.tsx` 新增可选 prop `forceOpenDismissible`（缺省 `false`，即 `forceOpen` 照旧完全锁死，计划卡 / todo / 子智能体等既有调用方不受影响）。为 true 时 `forceOpen` 只表示「默认展开」：用户点收起即收起，收起态只记在该组件实例内、不写 `toolLayoutOpenState`；`forceOpen` 变回 false 时该临时态被清掉。
- i18n：`packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` 新增 `chat.toolCall.turnSummary.*`（四个桶的计数文案）。没有 label 键——行首不显示类别词。

## 状态与时序

```
CLI rows ──▶ buildAssistantWorkRenderItems()
              ├─ 既有分组：exploreGroup / executeGroup / changesGroup（受 toolGrouping* 设置）
              └─ 折叠：turnSummary{ nodes:[连续过程项], counts, running: stageTailIsRunning && 是末段 }
                          │
ConversationTurnGroup ─────┴─▶ ConversationWorkRenderItem(kind 分发)
                                 ├─ row / agentToolCall / exploreGroup / executeGroup / changesGroup / cuaGroup
                                 └─ turnSummary ──forceOpenDismissible(running)──▶ ToolLayout ──▶ 同一套 kind 分发渲染 children
```

- 展开态所有者：`ToolLayout` 的模块级 `toolLayoutOpenState`（唯一写入方）。
- 折叠是纯函数投影，无可变状态；同一份 `rows` + 同一 `stageTailIsRunning` 必得同一结果。

## 验收场景

1. 一个回合里连续 2 条查阅 + 1 条终端 + 1 条思考 → 渲染一行「查阅了 2 次 · 终端 1 次 · 思考 1 次」（行首没有类别词，也没有前导「·」）；展开后是原来的 4 行。
2. 回合中夹着 `assistantText` 正文 → 正文不被折进汇总，汇总在正文两侧各成一段。
3. 文件写入工具（`Write` / `Edit`）→ 计入「编辑」；`toolGroupingChangesEnabled` 关闭时也一样计入。
4. 只有 1 条过程行 → 同样折叠为一行汇总。
5. 该段仍在运行（`stageTailIsRunning`）→ 汇总默认展开；此时点它 → 立即收起，后续流式追加的过程行不再把它顶开；再点一次可恢复展开。段结束后按默认收起态渲染，刷新 / 冷恢复后仍是收起态。
6. 展开汇总后，再展开其中一条终端分组 → 走终端分组原有的展开逻辑，正常看到命令与输出。
7. 展开汇总后，里面的读取 / 编辑 / 思考 / 终端各行之间是贴紧的一线缝（2px），与外层连续过程行同值；收起前后不出现「收起紧、展开散」的疏密跳变。
8. 带边框外壳的块（计划卡、自动化卡等）与相邻项之间的距离，上下两侧一致（各 16px）：块后面接过程汇总行或正文行时不再只剩 2px。
9. 平铺行之间（待办行、工具分组、子智能体行与过程汇总行、正文行相邻）一律 2px 贴紧，不再因为「是工具调用行」而拿到 16px。
10. 没拿到 plan markdown 的 `ExitPlanMode` 行按平铺行处理（2px），不按计划卡给 16px。
11. 子智能体 / CUA / 产物 / hook 行不被折叠，位置与形态与改动前一致。
12. 分享只读页 → 仍是逐行呈现，不出现汇总行。
13. 中英文界面下汇总文案跟随语言切换。

## 验证

- `pnpm typecheck`、`pnpm lint`（`max-lines` 是 error 级，投影文件因此拆出了折叠模块）。
- 单测：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/turnSummary.test.ts`
  - 覆盖：折叠口径、四类计数、分组按条数计、shell（含只读命令）归终端、写入工具计编辑、正文切段、单条折叠、末段 running、关闭开关后逐行铺开、文案跳过零值桶。
  - 间距判定另有一份 `packages/ui/test/conversationWorkItemGap.test.ts`：计划卡 / 自动化卡两侧都 16px、待办行与过程行 / 正文行同贴紧 2px、无 markdown 的 `ExitPlanMode` 不算卡、首项不加间距、三个常量取值。
  - 仓库既有测试同样依赖 tsx（`.js` 说明符指向 `.ts` 源文件，裸 `node --test` 跑不起来）；UI 包还带 `@/*` 路径别名，故需 `TSX_TSCONFIG_PATH`。仓库没有 React 渲染测试基建，交互层未做自动化验证。

## 未覆盖 / 已知取舍

- 收起态下过程行不挂载到 DOM（`ToolLayout` 的卸载延迟 300ms 后卸载）。此时按 rowId 定位的行锚点不存在：find 高亮 / 跳到行对一个被收起的过程行会找不到落点。展开后恢复正常。
- 该能力没有设置开关，默认开启（与 ZCode 侧补丁一致）；`ENABLE_TURN_SUMMARY` 常量与逐调用点的 `enableTurnSummary` 选项是保留的关闭闸门。
