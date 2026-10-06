# Spec: 对话时间线历史加载提示

## 目标

历史补页在网络较慢、用户快速滚动到长历史顶部时需要可见反馈；同时**快链路必须没有噪音**——补齐往往在几十毫秒内完成，让它闪一下是纯负收益。

本规范要求：顶部**常驻**一个固定高度的提示块，它的高度永远不变；块内那行文字由**透明度开关**控制——补齐开始后短暂等待，仍在进行才渐显，完成即淡出。

取窗单位与补齐规则见 `conversation-timeline-turn-window-fill.md`；块的几何与 inset 记账见 `conversation-timeline-top-placeholder.md`。

## 现状与根因

旧形态是**条件渲染**：`loadingOlder && canLoadOlder` 时块才出现，高度从 0 变 56px（`PENDING_HISTORY_SLOT_PX`）。由此产生两个问题：

1. **出现/消失都要补偿**：块占高度就进 `scrollMargin`，显隐两次改写 `scrollTop`，提交那一帧还要与前插增量合成一笔（`timelineTopInsetAdjustment`）。快链路下这块 56px 一闪而过，配合同步写入的 scrollTop，用户看到的是列表轻微一跳。
2. **提示语义错位**：`loadingOlder` 在预取提前两个视口就为真（`historyPrefetchTriggerPx`），提示在用户还没到顶时就出现，说的是「正在加载」而用户看到的仍是已加载内容。

改成常驻块后，高度恒定 → inset 恒定 → 没有显隐补偿这条链路；提示只在「用户已经贴着顶部、内容还差一屏」时才有意义，慢才显示。

## 产品规则

1. **块常驻**：提示块永远渲染在消息层最顶上（补页占位块原位置），高度恒定 `PENDING_HISTORY_SLOT_PX`（56px），不随加载状态出现/消失。它高度里包含的首轮顶距因此不再由首轮 `pt-14` 承担（见 `conversation-timeline-top-placeholder.md`）。
2. **文字靠透明度开关**：块内那一行（边框 + spinner + 文案）整体挂在 `opacity` 上。补齐进行中且超过 `HISTORY_LOADING_HINT_DELAY_MS`（400ms）仍未落进可见区才渐显到 1，补齐结束立即淡出。快链路全程透明，只占位不显形。
3. **信号语义**：`loadingOlder && canLoadOlder && !首绘 staging` 是唯一的显示条件来源，不再由「窗口里有没有 turnHeader」之类的内容推导。首绘 staging 期间一律不显形：那一刻可见区里还没有任何一轮，一行「正在加载更早消息」只会把「一次就位」直接说破（见 `conversation-timeline-turn-window-fill.md` 第 8 条）。
4. 提示使用已有 `chat.history.loadingOlderMessages` 文案，不新增本地化 key。
5. 保留 `TID_V4_TIMELINE_LOAD_OLDER`、`role="status"`、`aria-live="polite"`、`aria-atomic="true"`；**完全透明时内层 `aria-hidden`**。这是与「opacity 不影响可访问树」的相反取舍，理由是本规范的第一目标就是快链路无噪音：保留播报等于每次打开会话都对读屏用户念一句「正在加载更早消息」，而它随即就消失了。几何占位对读屏用户没有价值（那 56px 里没有内容），语义播报才有，所以只保留后者。
6. 提示宽度类由 `timelineContentColumnClass` 单一来源产出，与 staged 块 wrapper、真实内容列共用；固定高度 + `truncate` 单行，窄屏不换行不撑高。
7. 日志和提示不得包含消息正文、用户输入、凭据或完整用户数据。

## 状态所有权

`ConversationProjectionStore` 继续是 `loadingOlder` 与 `canLoadOlder` 的唯一业务 owner。`ConversationTimeline` 只消费 props 并决定透明度；不新增第二套请求状态、队列或计时器（延迟开关的定时器属于呈现层，随 pending 状态起落）。

## 布局与事件顺序

```text
补齐在途（离顶两视口触发取数）
  → 块常驻可见但透明，高度恒定，inset 不变（无 scrollTop 写入）
  → 400ms 后仍未提交 → 文字渐显
  → 用户滚到底提交 / 缓冲作废 → loadingOlder 翻 false，文字淡出
首开静默补齐（staging）
  → 同一块常驻且恒透明（信号被 staging 排除）
  → 够一屏 / 无更早 → 挂载后 loadingOlder 翻 false，全程没有一次淡入
```

## 负面边界

- 不修改 `rowsRange` 协议或 WebSocket 传输。
- 不给提示做入场动画、浮层样式或独立高度：它在文档流里，任何装饰性位移都会变成一次真实的内容位移。
- 不增加错误提示、重试按钮、超时、AbortController 或请求排队。
- 不把提示扩展到其他虚拟列表，也不增加 Web/Desktop 分支。
- 不删除现有时间线运行时探针。

## 验收

1. 本地 stdio 链路快速上滚到顶：顶部不出现任何加载文字，衔接无跳动。
2. 开发者工具限速（>400ms）后上滚到顶：顶部块内的 spinner 与「正在加载更早消息...」渐显，内容落入后淡出。
3. 贴在底部时看不到该块；滚到真顶时总留白与改造前一致（56px）。
4. 折叠后不足一屏的会话打开：补齐静默完成，无文字闪现；历史补完后无加载文字。
5. `canLoadOlder=false` 时永不渐显。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `packages/ui` 测试通过。
