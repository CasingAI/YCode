# Spec: 回合过程行折叠（Cursor 式过程收起）

> 本 spec 追加工具活动命名约定：过程行的查阅计数按文件/网页语义细分，查阅工具永远逐条铺开，其他折叠、行序和回放边界仍沿用下述规则。

## 目标

一个回合里连续出现的「查阅 / 终端 / 编辑 / 思考」行数量可以很大，逐条铺开会让正文被过程噪音淹没。本改动把**同一回合内连续的过程行**二次折叠成一行可展开的过程行，收起态显示一行计数：

```
2 次内容搜索 · 1 次文件查找 · 3 次文件读取 · 4 次网页搜索 · 6 次网页读取 · 终端 3 次 · 编辑 1 次 · 思考 4 次
```

展开后回到逐条铺开的那些行（查阅行 / 终端行 / 编辑行 / 思考行），再展开其中某一行仍走各自原有的展开逻辑看明细 —— 两级展开。

工作段状态行另有「工具 N 次 · 思考 Y」的总览指标；它按正式 `ToolCallRow` 和 reasoning duration 统计，并递归合并子代理用量，不改变本 spec 的四类过程折叠口径。详见 [`conversation-work-segment-usage.md`](./conversation-work-segment-usage.md)。

后台任务跑完另起的「唤醒轮」（`origin: "backgroundResult"`）不参与本 spec 的四类折叠，它只把过程行收进标题行下方的折叠区，正文与后续行常驻。详见 [`background-result-turn-collapse.md`](./background-result-turn-collapse.md)。

## 产品规则

- **工具活动分类只在共享 UI 展示层派生**：运行时工具记录是工具身份、输入、状态与行序的唯一事实所有者；`packages/ui/src/lib/toolCallActivity.ts` 提供纯函数 `classifyToolCallActivity({ toolName, kind, input, raw, output })`，共享 renderer、单行查阅工具的动作标签与过程折叠共用它，不新增状态。返回 `file-search | file-find | directory-list | file-read | web-search | web-read | unknown`，且按可信工具名/身份分类；URL、query 内容及 title 均不得用于猜测网页类别。
- **查阅工具的动作标签**：Grep 显示「搜索文件内容 / 搜索文件内容中」，Glob 显示「查找文件 / 查找文件中」，列目录显示「列出目录 / 列出目录中」，Read 显示「读取文件 / 读取文件中」；WebSearch 显示「搜索网页 / 搜索网页中」，WebFetch 显示「读取网页 / 读取网页中」。标签直接落在每条工具行上。中文进行态不使用“正在”，动作统一尾缀“中”；英文使用自然进行时。完成时显示中性动作，失败/拒绝/取消保留已有状态提示，不映射成成功。
- **行内摘要**仅显示动作和目标，不重复“搜索”“查找”等类别词；目标尚未到达时只显示一次动作。通用 Read 若明确表示目录，按「列出目录」处理。查阅工具不再有「文件查阅 / 网页查阅」父级组标签，每条行只显示自己的动作和目标；该行已完成时动作恢复中性。
- **Web/Share 同步**：`ConversationShareReadonlyTimeline` 的 search/read 展示也使用共享分类及相同动作文案，不因 Desktop/Web/手机或只读分享入口而回退到笼统“搜索/读取”。
- **过程行计数**按工具实际语义分别显示「N 次内容搜索 / 文件查找 / 目录列出 / 文件读取」及「N 次网页搜索 / 网页读取」。WebFetch 即使读取 Bing URL 仍是网页读取；Grep 即使搜索 URL 仍是文件内容搜索。
- **行序**严格按原始行序铺开；文件查阅与网页查阅只按行各自标注，不合并、不排序、不跨越中间行。未知工具和旧记录缺乏可信身份时使用可解释的中性回退，不根据 title 猜网页。
- **错误、时序与回放边界**：分类只读已有 runtime tool record，不改状态所有权、工具事件顺序、错误/取消/拒绝语义，亦不扩展协议、持久化或 Desktop continuous / mobile replayable 机制。Desktop/Web/手机共用 UI 投影；历史记录缺字段时中性兼容，无迁移。
- **折叠单位是「连续过程行」**。判定与既有 `buildAssistantWorkRenderItems()` 的工作项输出同源，不重新解析工具输入：
  - 每条查阅工具行独立参与分类与计数，不先合成中间分组。
  - `row` 且 `row.kind === "reasoning"` → 思考
  - `row` 且 `row.kind === "toolCall"` → 复用 `isExploreToolCall` / `isExecuteToolCall` / 文件写入家族（`file-write`）判定，分别归入查阅 / 终端 / 编辑
    - 「查阅」细分桶复用 `classifyToolCallActivity`：文件与网页独立计数；工具身份无法可信细分的旧记录不参加查阅计数，且不能根据 title 或 URL 反推。
    - **shell 家族一律归「终端」**，不按命令内容重判。
    - 命令还没到的 shell 行（`isShellToolCallAwaitingCommand`）两个桶都不进，保留为独立行。
  - 其余（不属于上述四类的工具行、`assistantText`、`artifact`、`subagent`、`hookInvocation`、`timelineMarker`、`agentToolCall`、`cuaGroup`）**不参与折叠**，照旧铺开：正文、待办、子智能体、CUA、产物、hook 明细都不能被折进去。Todo 工具卡片始终参与消息流渲染，不再提供“显示待办”开关；待办作为可见独立行隔开前后过程段，详见 [`todo-display-always-on.md`](./todo-display-always-on.md)。
- **计数口径**：每条过程行计 1（总计为 `rows.length`），不按分组聚合。查阅计数按 `file-search`、`file-find`、`directory-list`、`file-read`、`web-search`、`web-read` 分列，不再合并成「搜索 / 列表 / 文件」；未知类别不猜测、不并入上述计数。计数为 0 的桶不出现在文案里。
- **查阅行不分组**：每条查阅工具单独成行，按原始行序铺开；文件查阅与网页查阅只是同一批行的活动标注，不合并成可折叠容器，也不跨越或重排原始行序。外层过程行仍可包含查阅、终端、编辑和思考行，并使用细分计数。
- **动作状态**：仅实际执行状态（v4 `running` 或旧记录 `in_progress`）展示进行态动作，中文统一“中”尾缀；输入生成、等待审批和排队不得显示执行中的动作。完成时用中性动作。失败、拒绝、取消仍显示原状态提示，不能映射为成功动作；此规则同样适用于只读分享摘要。
- **终端桶只有一条形态**：终端行永远逐条铺开，展开过程行后每条各自可展开看命令与输出，这一桶只存在**一层**折叠。曾经有过的终端分组（「终端 · N 个命令」容器）已整体删除，连同它的设置项 `toolGroupingTerminalEnabled` / 「分组终端命令」一起：在会话里那一层只可能出现在过程行内部，等于给同一批命令叠第二道折叠 —— 用户展开过程行本来就是要看命令行，却还要再点开一次容器。因此它不再是「终端这一桶可以配置的形态」，也不要再按聚合容器的样式把它加回来；两个渲染入口（会话消息流 `ConversationTurnGroup`、分享只读页 `ConversationShareReadonlyTimeline`）都走同一条逐条渲染路径。
- **编辑桶只有一条形态**：文件写入家族（`Write` / `Edit` 等）归入「编辑」桶，行永远单行铺开（文件名 + diff 计数），展开过程行后每条各自可展开看 diff，这一桶只存在**一层**折叠。曾经有过的编辑分组（「更改 · 文件名」容器）已整体删除，连同它的设置项 `toolGroupingChangesEnabled` / 「分组文件更改」一起：在会话里那一层只可能出现在过程行内部，等于给同一批编辑叠第二道折叠 —— 用户展开过程行本来就是要看改了哪里，却还要再点开一次容器；同一文件被连续编辑时它收起摘要只报得出「+1」这类自指计数，也失去存在的意义。因此它不再是「编辑这一桶可以配置的形态」，也不要再按聚合容器的样式把它加回来；两个渲染入口（会话消息流 `ConversationTurnGroup`、分享只读页 `ConversationShareReadonlyTimeline`）都走同一条逐条渲染路径。
- **查阅桶只有一条形态**：查阅工具（Grep / Glob / 列目录 / Read / WebSearch / WebFetch）永远逐条铺开，展开过程行后每条各自可展开看明细，这一桶只存在**一层**折叠；过程行自身的计数折叠保留，连续查阅行仍会折成一行计数，六种活动桶（`file-search` / `file-find` / `directory-list` / `file-read` / `web-search` / `web-read`）细分计数不变。曾经有过的 Explore 聚合分组（「文件查阅 · N 次文件读取」「网页查阅 · N 次网页读取」容器）已整体删除，连同它的设置项 `toolGroupingExploreEnabled` / 「分组探索工具」一起：在会话里那一层只可能出现在过程行内部，等于给同一批查阅操作叠第二道折叠 —— 用户展开过程行本来就是要看具体读取了什么，却还要再点开一次容器。因此它不再是「查阅这一桶可以配置的形态」，也不要再按聚合容器的样式把它加回来；两个渲染入口（会话消息流 `ConversationTurnGroup`、分享只读页 `ConversationShareReadonlyTimeline`）都走同一条逐条渲染路径。`ExploreToolCallBlock` 只作为历史会话中 `kind === "explore"` 旧记录的兜底渲染路径保留，不再有新的产生来源。
- **长度不设门槛**：连续过程行即使只有 1 条也折叠成一行过程行（与 ZCode 侧既有行为一致），保证「过程永远只有一行」的可预期性。
- **运行中默认展开、可手动收起**：过程行位于当前工作段尾部且该段仍在运行时，默认展开，过程对用户实时可见；用户若在此时点它收起，就尊重这个选择——本段运行内不再自动弹开（流式追加的新过程行也不能把它顶开），且这个收起**持久化到展开态表**，跨重挂载 / 冷恢复仍然有效，段结束或页面重载后也保持收起。
  - `running` 只是**默认态**，不是**约束**：它决定「用户从未手动操作过的那一行」初始是展开还是收起，一旦用户在 forceOpen 期间显式收起（表里记 `false`），后续任何使 `running` 重新成立的渲染都不再把它顶开；用户重新展开（表里记 `true`）同样被记住。语义即「用户的显式选择优先于 running 默认」。
  - 实现上给 `ToolLayout` 的 `forceOpen` 配 `forceOpenDismissible`（把「锁死」降级为「默认展开」），**不使用** `autoOpen` + `autoCollapseOnComplete`。后者依赖 `isRunning` 的 true→false 跳变，而回合结束时 flow item 的 key 会变化导致整个列表重挂载，模块级展开态表里被 `autoOpen` 写下的「开」会被新实例恢复，跳变却再也不会发生 → 该组永远展开。
  - 展开态表只在用户**显式点按** forceOpen 行时写入（收起记 `false`、展开记 `true`）。绝不因 `autoOpen` / `autoCollapseOnComplete` 等自动行为写表，避免把自动展开误当成用户意图、让该行再也回不到默认收起态。
- **行首不带重复类别词**：过程行直接以计数开头，文件/网页查阅各自使用细分计数词条（如「2 次内容搜索 · 3 次网页读取 · 1 次终端 · …」）；类别词缺席时分隔点一并省掉，避免行首留下孤立分隔符。查阅工具不再有文件/网页组标签，单行只显示自己的动作标签，不在过程计数中重复显示。
- **展开态持久化**：复用 `ToolLayout` 的模块级 `toolLayoutOpenState`（进程内、按 key），键锚定过程行的**首个子项**，因此流式追加子项时不重建组件、不丢展开态。`rowId` 只在单次 `(sessionId, logEpoch)` 物化范围内唯一，持久键必须同时带这两个作用域；否则并行 Subagent 中相同 `rowId` 的历史过程行会共享展开态。状态仍只存在于当前 renderer 进程，不落 localStorage。
- **只动渲染层投影**：不改行数据、不改持久化、不改协议。`buildAssistantWorkRenderItems()` 的输入与行序不变。权限拒绝的结构化字段不改变过程行计数，但每条被拒绝的工具行必须保留“已拒绝”语义，不能因折叠聚合为普通 stopped 或 completed。
- **分享只读时间线不折叠**：`ConversationShareReadonlyTimeline` 显式传 `enableProcess: false`，保持既有的逐行呈现。
- 文案走 i18n（中英各一套），不硬编码中文。
- 中文动作词使用统一分类词条；进行态只在 `running` 时显示 `…中`，英文使用自然时态。失败、拒绝和取消状态继续由现有状态文案展示。

## 接口

- 分类入口：`packages/ui/src/lib/toolCallActivity.ts` 导出纯函数 `classifyToolCallActivity({ toolName, kind, input, raw, output })`，结果类型为 `ToolCallActivity`（`file-search | file-find | directory-list | file-read | web-search | web-read | unknown`）。`isToolCallActivityRunning` 判断实际执行态；`getToolCallActivityTarget` 提取目标，WebFetch 只以 URL 作为目标。调用方不得另写类别和目标识别规则。未知身份中性回退，不根据 title 或 URL 猜网页。
- Read 元数据入口：`packages/ui/src/lib/readToolMetadata.ts` 导出纯函数 `readToolMetadata(input, raw, output)`，renderer、分类和只读分享共用。支持结构化 input、`parsed_cmd`、旧 rawInput/rawOutput/content 与当前 output 中的显式路径和目录类型。目录类型和路径可来自不同字段，输出只有目录类型时保留 input 路径；`parsed_cmd` 相对路径按其 cwd 拼接，支持 Windows、macOS、Linux 和远程工作区。
- UI 投影链路（状态与事件顺序不变）：`runtime ToolCallRow (identity/input/status/order owner) → classifyToolCallActivity → shared UI renderer / process fold → Desktop, Web and mobile replay views`。分类是同步纯计算，不新增异步协议、状态或持久化。
- 投影：`packages/ui/src/v4/conversationAssistantWorkItems.ts`
  - 新增导出类型 `ConversationAssistantWorkChildItem`（原 `ConversationAssistantWorkRenderItem` 的全部成员）、`ConversationProcessRenderItem`，`ConversationAssistantWorkRenderItem` 变为二者的联合。
  - `ProcessBucket` 与 `ProcessCounts` 使用六种 `ToolCallActivity` 活动桶加 `terminal | changes | reasoning`；不另设聚合 `explore` 计数，避免细分活动重复计数。
  - 新增常量 `ENABLE_TURN_PROCESS = true`；`ConversationAssistantWorkRenderOptions` 新增可选 `enableProcess`（缺省取常量）。
  - `buildAssistantWorkRenderItems()` 在既有分组之后做一次折叠，输出 `kind: "process"` 项：`{ key, rowId, nodes, counts, running }`。
- 渲染：`packages/ui/src/v4/ConversationTurnGroup.tsx`
  - 新增 `ConversationProcessRow`：`ToolLayout` 外壳（`forceOpen={running}` + `forceOpenDismissible`、`isRunning={running}`、`kindLabel={null}`、不传 `summaryContentSeparator`），`primaryText` 为过程行文案，内容为子项按原有 kind 分发渲染。
  - `persistOpenKey` 由 `packages/ui/src/v4/conversationProcessOpenKey.ts` 的纯函数生成，格式固定为 `zc-turn-process:{sessionId}:{logEpoch}:{processKey}`；`processKey` 继续锚定首个子项，`sessionId` 与 `logEpoch` 负责隔离不同会话和不同物化纪元。
  - 抽出共享的 `ConversationWorkRenderItem`（kind 分发），供顶层列表与过程行内容共用，避免两处分发漂移。
  - `ConversationAssistantWorkItems` 的工作项容器不设统一 gap，纵向间距挂在每一项自己身上（`workItemGapClass`）：间距按**相邻两项的类型**给——边界任一侧是**带边框外壳的块**（渲染出来是独立盒子的那一类）就沿用收紧前的 16px，块上下两侧因此对称；两侧都不是带边框外壳的块（过程行、正文行、思考行、平铺工具行）才贴紧到 2px，把连续过程连成一片；首项不加间距。容器 gap 无法区分项类型，而这两种间距需要并存，故间距放到项上。父级 flow 容器（`gap-5`）、history 折叠外壳（`pt-5`）不受影响。分享只读页不共享该容器，保持原间距。
  - 过程行展开后的子行同样贴紧到 2px（`TURN_PROCESS_CONTENT_GAP_CLASS`，与外层贴紧态同一个值，只是换成 `space-y` 作用域）：收起态与展开态是同一批过程行的两种呈现，疏密必须一致。
  - flow 容器（`ConversationWorkSegmentFlow`）的默认行距 20px（`mt-5`）只留给**用户气泡**和**工作段表头那一行**（`AssistantHistoryStatus`，以及紧随其后的第一个助手块）：这两处是分界，气泡与表头都要独立成段。助手侧内容之间（过程块 ↔ 正文段 ↔ 过程块、history 折叠块 ↔ 过程块）改用同一套 `flowItemGapClass`：默认 2px 贴紧，边界任一侧是带边框外壳的块时 16px——否则同一段过程会被正文段切成 20px 的几截，列表内已经贴紧、跨 flow 项却留一个洞。判定只看 flow 项，用户气泡与表头不参与「助手侧连成一片」。
  - 分类过的 flow 项带 `data-flow-gap` 标记，退出容器那条默认规则（`:not([data-flow-gap])`），间距只由自己挂的 class 决定，避免两条同权重规则互相盖。history 折叠外壳不能在外层挂外边距（收起动画最后一帧会多算一段高度），同一个间距以 `pt-*` 放进动画层内部（`flowGapPaddingClass`）。
- 间距判定：`packages/ui/src/v4/conversationWorkItemGap.ts` 导出 `isBorderedShellWorkItem` / `isBorderedShellWorkRow`、`workItemGapClass`、flow 层的 `conversationFlowGapSides` / `flowItemGapClass` / `flowGapPaddingClass` 与四个间距常量（`WORK_ITEM_TIGHT_GAP_CLASS` / `WORK_ITEM_CARD_GAP_CLASS` / `WORK_ITEM_USER_GAP_CLASS` / `TURN_PROCESS_CONTENT_GAP_CLASS`），供 `ConversationTurnGroup` 使用并单测覆盖——仓库没有 React 渲染测试基建，抽成纯函数是锁住这条规则的唯一办法。
  - 「带边框外壳」是按**渲染结果**判的，清单必须与渲染器最外层同源：`ToolLayout` 平铺行（绝大多数工具行、子智能体、CUA 分组、`TodoWrite` 的待办行、`CreateWorkflow` 行）没有边框与背景，一律算平铺；当前算带边框外壳的只有 `switch-mode` 计划卡、`cron-create` / `offpeak-create` 自动化卡、`resume-workflow-run` 已联接 run 时的紧凑卡。新增带边框外壳的卡片渲染器时要同步登记，否则它的上下间距会退回 2px 贴平。
  - 计划卡那一支与渲染器**共用同一份判据** `hasPlanCardContent`（`packages/ui/src/lib/planToolCall.ts`）：正文、标题、概述任一在场即算卡片。`ExitPlanMode` 按 `title` → `overview` → `plan` 顺序流出，流式期正文还没到、卡片已用前两个字段成形，间距必须同一时刻就按 16px 排。历史上这里只认 `markdown`，卡片渲染器放宽后它落后一版，表现为流式期 2px、定稿瞬间跳成 16px。三个字段全空才退化成平铺输出块。
- 外壳能力：`packages/ui/src/ToolCallBlocks/ToolLayout.tsx` 新增可选 prop `forceOpenDismissible`（缺省 `false`，即 `forceOpen` 照旧完全锁死，计划卡 / todo / 子智能体等既有调用方不受影响）。为 true 时 `forceOpen` 只表示「默认展开」：用户点收起即收起，**且该选择写入 `toolLayoutOpenState`**（收起记 `false`、展开记 `true`），因此跨重挂载与冷恢复都保留；`forceOpen` 变回 false 不清除这份用户意图。`forceOpenDismissible` 当前唯一调用点是过程行 `ConversationProcessRow`。
- i18n：`packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` 新增工具动作与过程计数文案。中文进行态统一“中”尾缀；英文采用自然时态。

## 状态与时序

```
CLI rows ──▶ buildAssistantWorkRenderItems()
              ├─ 既有分组：cuaGroup
              └─ 折叠：process{ nodes:[连续过程项], counts, running: stageTailIsRunning && 是末段 }
                          │
ConversationTurnGroup ─────┴─▶ ConversationWorkRenderItem(kind 分发)
                                 ├─ row / agentToolCall / cuaGroup
                                 └─ process ──forceOpenDismissible(running)──▶ ToolLayout ──▶ 同一套 kind 分发渲染 children
```

- 展开态所有者：`ToolLayout` 的模块级 `toolLayoutOpenState`（唯一写入方）。
- 折叠是纯函数投影，无可变状态；同一份 `rows` + 同一 `stageTailIsRunning` 必得同一结果。

## 验收场景

1. 一个回合里连续 1 条 Grep + 1 条 Read + 1 条终端 + 1 条思考 → 渲染一行「1 次内容搜索 · 1 次文件读取 · 终端 1 次 · 思考 1 次」（没有前导类别词或分隔符）；展开后按原序保留查阅行、终端和思考。
2. 回合中夹着 `assistantText` 正文 → 正文不被折进过程行，过程行在正文两侧各成一段。
3. 文件写入工具（`Write` / `Edit`）→ 计入「编辑」，行保持单行；同一步内连续多次编辑也不再折出「更改」容器，计数仍按条数计。
4. 只有 1 条过程行 → 同样折叠为一行过程行。
5. 该段仍在运行（`stageTailIsRunning`）→ 过程行默认展开；此时点它 → 立即收起，后续流式追加的过程行不再把它顶开；再点一次可恢复展开。收起在整段运行内保持有效（即使中途 `running` 短暂翻转），段结束后仍是收起态，刷新 / 冷恢复后也仍是收起态。
6. 展开过程行后，终端行逐条展示、每条各自可展开看命令与输出；连续多条终端也只多出这几行，不出现第二层「终端 · N 个命令」容器。
7. 展开过程行后，里面的读取 / 编辑 / 思考 / 终端各行之间是贴紧的一线缝（2px），与外层连续过程行同值；收起前后不出现「收起紧、展开散」的疏密跳变。
8. 带边框外壳的块（计划卡、自动化卡等）与相邻项之间的距离，上下两侧一致（各 16px）：块后面接过程行或正文行时不再只剩 2px。
9. 平铺行之间（待办行、子智能体行与过程行、正文行相邻）一律 2px 贴紧，不再因为「是工具调用行」而拿到 16px。
10. 没拿到 plan markdown 的 `ExitPlanMode` 行按平铺行处理（2px），不按计划卡给 16px。
11. 子智能体 / CUA / 产物 / hook 行不被折叠，位置与形态与改动前一致。
12. 分享只读页 → 仍是逐行呈现，不出现过程行。
13. 中英文界面下过程行文案跟随语言切换。
14. 同一工作段里「过程块 → 正文段 → 过程块」是贴紧的一线缝（2px）：正文段上下不再各留 20px；用户气泡与表头行（「已停止 / 工作了 N 秒」）与相邻内容仍是 20px。
15. 助手侧内容与带边框外壳的块相邻时（过程块末尾的计划卡后面接正文段、正文段后面接以卡片开头的过程块）按 16px，与工作项列表内卡片的间距同值，块上下仍对称。
16. 两个并行 Subagent 的过程行首项恰好具有相同 `rowId`：在其中一个会话展开历史过程行，不改变另一个会话的展开态；另一个会话仍只默认展开当前运行段末尾。
17. 同一会话重新绑定、`logEpoch` 变化后不继承旧物化纪元的展开态，历史过程行按默认收起渲染。
18. Grep/Glob/Read → WebSearch/WebFetch → Grep/Read 依次逐条铺开，不合成任何查阅分组容器；展开后各行不重排，过程计数分别累计六种活动。
19. WebFetch 读取 Bing 搜索结果页显示「读取网页」和 URL；Grep 搜索 URL 显示「搜索文件内容」和查询文本。中文执行态使用“中”，英文使用自然进行时。
20. Read 的目录类型只出现在 rawOutput/content/output 中，路径只在 input.file_path 中：普通行、过程计数和只读分享均识别为目录，并保留目标路径。
21. 运行中的 WebSearch / WebFetch 单行显示「搜索网页中 {query}」或「读取网页中 {url}」；完成后动作恢复中性；目标未到达时动作不重复。
22. 输入生成、等待审批、失败、拒绝和取消不显示执行中的动作；失败、拒绝和取消在普通工具行及只读分享摘要中保留可见状态。

## 验证

- 使用 `mise.toml` 指定的 Node 运行 `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed`。`max-lines` 是 error 级，投影文件因此拆出了折叠模块。
- 单测：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/processFold.test.ts packages/ui/test/processOpenKey.test.ts`
  - `processFold.test.ts` 覆盖：六种查阅活动计数、查阅行逐条计数、shell（含只读命令）归终端、写入工具计编辑、相邻终端行各自成行、正文切段、单条折叠、末段 running、关闭过程折叠后逐行铺开、文案跳过零值桶，以及中英文 renderer 与单行查阅动作标签。
  - `toolActivityRender.test.ts` 覆盖：目录元数据合并、跨平台目标路径、文件与网页交替时保持原始行序并逐条渲染、WebFetch URL 优先、无目标不重复动作、输入生成和审批不显示执行态，以及只读分享的目标与失败/拒绝/停止状态。两份 renderer 测试需带 `--import ./packages/ui/test/helpers/registerAssetStubs.mjs`。
  - `processOpenKey.test.ts` 覆盖：相同作用域生成相同键、不同 `sessionId` / `logEpoch` 隔离相同 `processKey`、缺失作用域时稳定回退。
  - 间距判定另有一份 `packages/ui/test/conversationWorkItemGap.test.ts`：计划卡 / 自动化卡两侧都 16px、待办行与过程行 / 正文行同贴紧 2px、无 markdown 的 `ExitPlanMode` 不算卡、首项不加间距、四个常量取值；flow 层用真实 `buildConversationFlowItems` 输出覆盖「过程块 → 正文段 → 过程块 = 2px、用户气泡 / 表头之后仍是默认 20px、卡片边缘 16px」与 `mt-*` → `pt-*` 的映射。
  - 仓库既有测试依赖 tsx（`.js` 说明符指向 `.ts` 源文件）；UI 包带 `@/*` 路径别名，使用 `TSX_TSCONFIG_PATH` 或 `tsx --tsconfig packages/ui/tsconfig.json`。React 静态渲染测试覆盖摘要和展开配置，不等于真实点击 E2E；本次未操作正在运行的 YCode。

## 未覆盖 / 已知取舍

- 收起态下过程行不挂载到 DOM（`ToolLayout` 的卸载延迟 300ms 后卸载）。此时按 rowId 定位的行锚点不存在：find 高亮 / 跳到行对一个被收起的过程行会找不到落点。展开后恢复正常。
- 过程行折叠本身没有设置开关，默认开启（与 ZCode 侧补丁一致）；`ENABLE_TURN_PROCESS` 常量与逐调用点的 `enableProcess` 选项是保留的关闭闸门。
- Explore 聚合容器与设置项 `toolGroupingExploreEnabled` / 「分组探索工具」已整体删除，删除后不可再按旧样式加回来。`ExploreToolCallBlock` 仅作为历史会话中 `kind === "explore"` 旧记录的兜底渲染路径保留，不再有新的产生来源。
