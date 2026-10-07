# Spec: 对话时间线前插提交闸门

## 目标

长历史补页（`loadOlder`）的取数提前一个预取带发出以藏网络延迟，但**落窗口**必须等到「待插入内容的真实高度已经全部量出来」。落窗口会触发 `scrollTop` 补偿；带着估值提交时，虚拟行渲染完才被真实高度修正，每次修正都要再补一次 `scrollTop`，同一个位移被算多遍，列表漂移。

本规范把补页拆成三段：取数 → **staged 块渲染与就绪** → 一次落窗口。落窗口期间列表锁死滚动，块级就绪闸门是硬前置条件。顶部占位块本身见 `conversation-timeline-top-placeholder.md`；块的切分、staged/committed 同位迁移与 inset 记账见 `conversation-timeline-prepend-blocks.md`。

## 现状与根因

### 主因：没有高度闸门，补偿在测量之后才补

待插入的行在真正渲染前只有 `estimateSize`。提交时它们进入虚拟列表，渲染完被真实高度修正，于是：

```text
virtualizer  shouldAdjustScrollPositionOnItemSizeChange  对每条视口上方新测量的行各加一次高度
手写 prepend 补偿                                            element.scrollTop += adjustment
inset 补偿                                                    element.scrollTop += ΔscrollMargin
```

同一次提交里三个写手各算一遍同一个位移，误差叠加，滚动位置被推到远超应到之处——表现为「内容疯狂漂移到非常远的地方」。

放大器是保护窗错配：`USER_SCROLL_INTENT_TTL_MS = 1200`，原先的静止等待设为 3000ms。提交时刻落在窗外，`shouldAdjustVirtualizerForItemSizeChange` 从 `return false` 变成 `return itemEnd <= input.scrollTop`，自动调整由关变开。

> 说明：行本身没有变高变矮。**第一次被量**对 virtualizer 就是一次 size change——从估值到真值。这与宽度调整无关。

### 次因：占位块让 `scrollMargin` 变成高频变动量

`topInsetPx = headerSlotHeight + pendingHistorySlotHeight` 直接喂给 `scrollMargin`。占位块每次补页开关一次，`scrollMargin` 就 ±56。而周围锚点机制都按 `scrollMargin` 准静态写成：`getVirtualItemForOffset(element.scrollTop)` 传裸 `scrollTop`、`prependScrollAdjustment` 用不含该 56px 的 `getTotalSize()`。

### 矮内容死锁：位置账本与布局脱节，且兜底只保护「从未滚过」

打开会话后固定行数的冷快照窗口 + 工具调用折叠，总高度可能小于视口：`scrollTop` 恒为 0，滚动容器再也不产生 scroll 事件。此时两条唤醒链同时断掉：

```text
取数完成 → pendingOlder 缓冲（loadingOlder 恒真，占位块持续显示）
  → 闸门账本 lastScrollTopPx 里残留一个过期的大于 0.5px 的值
  → atTop() 恒假 → 不排程提交
  → 没有新的 scroll 事件 → 账本永不更新 → pending 永久挂起
```

账本只在归类为 user 的 scroll 事件里由 `noteScroll` 更新，而「浏览器改变 scrollTop 必发 scroll 事件」的前提在虚拟列表里不成立：折叠/展开与测高收缩会让 `scrollHeight` 剧变，浏览器自发 clamp `scrollTop`，这类变化要么没有事件（写入即被钳制、值没变过），要么事件被 layout guard 吞掉归为 layout 而跳过账本。程序化标记也只活一帧 rAF，迟到的事件还会掉进「未分类按 user 处理」的 fallback——于是账本记的位置与真实布局脱节。

第 4 条的兜底只覆盖「从未滚过（null）」：滚过一次、内容后来矮到滚不动的会话不在保护范围内。再加上第 6 条刻意不设时间等待，pending 窗口没有任何自愈——用户把工具调用展开（内容变高、重新可滚）时，一次真实滚动同时修活提交与触发两端，这正是「展开后再滚就能恢复」的全部原因。

### 主因（活跃会话）：窗口换代把待提交请求丢掉，且没人补上

活跃会话每收到一帧 snapshot 就整体替换窗口并 `windowEpoch + 1`。原先的换代复位 effect 里带着 `gate.cancel()`，而负责重新求值的闸门 effect 依赖只有 `hasPendingOlder / loadingOlder / runPrependCommit / sessionKey`——**没有 `windowEpoch`**。换代本身又不改动前四项，于是：

```text
缓冲里躺着更早的一页（pendingOlder 非空，loadingOlder 恒真）
  → snapshot 帧换代 → 复位 effect 的 gate.cancel() 清掉 requestedCommit
  → 依赖没变，闸门 effect 不重跑 → 没有任何人重新 request
  → store.loadOlder 见 pendingOlder 非空直接返回，finally 又按「缓冲非空」留 loadingOlder=true
  → 占位块 loadingOlder && canLoadOlder 永久显示，所有补页入口同时被挡死
```

这是**换代与提交两套 effect 之间的失联**，不是位置判定问题：位置账本此时多半是对的（用户确实在顶部），可提交请求已经不存在了。游标失配由 `commitPendingOlder` 自己判并回 `retry`（产品规则 13/14），换代前 `cancel` 属于重复防护，代价却是死锁。

「后来新追加一条内容，它自己又加载了」与补页无关：那次追加顺带撞开了某条重新求值的路径（`loadingOlder` 或 `hasPendingOlder` 恰好变化），请求才被重新挂上。这也是为什么它看起来「有时候会自己好」。

## 产品规则

1. `loadOlder` 只取数，取回的行进 `pendingOlder` 缓冲，不改窗口。
2. 落窗口需要**两组条件同时成立**：其一为位置与事实——已停在顶部（`scrollTop <= PREPEND_COMMIT_TOP_EPSILON_PX`，0.5px，**以提交裁决时刻的布局对账值为准**），且待插入行的真实高度全部量出；其二为填充条件（`conversation-timeline-turn-window-fill.md` 规则 11）——staged 折叠高度已铺满一屏、且整轮到齐（缓冲最老行是 `turnHeader`），或已没有更早历史，或收到中断信号。填充条件不满足时闸门不放行，由 Timeline 的填充循环继续静默取页（缓冲累积在暗处排版，用户不可见）。
3. 位置事实 = 用户 scroll 事件的高频更新 + 每次 `request` 时**以容器实时 scrollTop 对账一次**。scroll 事件仍是高频更新源，但它可能过期（内容收缩时的 clamp、无事件的钳制、guard 归类）；`request` 发生在 effects 阶段，此时 DOM 的 `scrollTop` 就是布局终值，含浏览器对内容收缩的 clamp，是提交裁决的最终依据。调用方在 request 时传入容器实时 `scrollTop`，为有限数即覆盖账本，否则沿用账本（未挂载时保持 null 兜底）。
4. 从未滚过（`null`）按在顶部处理：内容不足一屏的补页没有「继续上滑」这个动作，不该因此永远卡在缓冲区。滚过之后账本不再是 null，由第 3 条的对账机制保证与布局一致。
5. 只有真实用户来源的 scroll 事件参与位置判定。布局补偿与程序化滚动写的是自己的 `scrollTop`，不应被当成用户手势。
6. **不设任何时间等待。** 位置条件（到顶）加上 pending 窗口内的滚动锁已经排除并发手势，等待时长不参与正确性。原先的 `PREPEND_COMMIT_IDLE_MS` 已删除。
7. **块级就绪是构造性的，不设独立状态**：闸门 effect 与提交回调都跑在 effects / task 阶段，而 effects 只在 commit（staged 的 DOM 已挂）之后运行，`request(hasPendingOlder, ...)` 时 staged 必然已渲染。此前用一个会倒退的 `stagedPrependMeasured` 布尔证明它，切会话置回 false 后没有任何东西能再推进（staged 单元命中 EMPTY 常量、就绪 effect 不触发）→ 闸门永关 → pending 永存 → `loadingOlder` 恒真挡死预取、到顶锁死不释放，整个会话无法上滚。没有超时、没有兜底放行；staged 为空（空页或纯尾页）时 `stagedTurnIds` 为空、直接提交窗口合并，Δ=0 也允许，防死锁。
8. **抵达顶部才锁滚动**：`isTimelinePrependScrollLocked(hasPendingOlder, reachedTop)`。锁从「用户抵达顶部」一直持续到内容装载与高度调整落定。
9. **锁的起点不能是「取数开始」**。预取提前两个视口发出（`historyPrefetchTriggerPx = 2 × viewportHeight`），若跟着 `loadingOlder` 上锁，用户会在离顶两屏处被冻住、再也上不去；第 2 条要求到顶才提交，位置条件恒假，提交永不发生，锁也就永不释放——锁与顶部条件互相把对方把对方锁死。「用户看到占位块」正是抵达顶部那一刻，所以锁的起点也正是那一刻。`reachedTop` 与闸门的 `atTop()` 读同一个 `scrollTop`，「能提交」和「已上锁」必然同时到达。
10. 锁复用滚动容器的 `overflow-y-hidden`。容器已有 `[scrollbar-gutter:stable]`，锁不会引起横向位移；`overflow: hidden` 保留 `scrollTop`。
11. **提交是单写手的一次写入**：`flushSync` 内完成并入，前插项与 inset 项合成一笔 `element.scrollTop += adjustment + insetAdjustment`。分两次写会在中间多出一个 scroll 落点，被当成用户滚动基线。
12. **inset 账本只能由真正写入它的那一处结算**。prepend effect 的「无 prepend 写入」分支不得调 `settleTopInset`——账本记的是「已补偿到哪」，提前结清等于告诉独立补偿 effect「这段差值已补过」，而它并没有被写入。占位块出现那一帧走的正是这条分支，结果是 `scrollMargin` 变了 +56 而 `scrollTop` 没动。
13. 缓冲自带取数水位（`beforeRowId` + `logEpoch`）。提交时窗口首行或纪元对不上就整批作废并按新游标重取。
14. 作废与「这一页本来就没有更早内容」必须可区分：前者重取，后者不重取（否则空页自旋）。
15. `loadingOlder` 覆盖「取数在途 **或** 待提交缓冲」，两者都结束才翻 `false`。
16. **预取触发不唯一依赖 scroll 事件**：消息层高度变化（折叠/展开、测高收缩、占位块显隐）同样评估预取，调用与 scroll 路径同一套 `shouldTriggerLoadOlder` 判定与两视口阈值。防环由 store 单飞（取数在途或缓冲未提交时重复调用 no-op）与 `loadingOlder` 守卫天然成立——占位块 ±56px 触发高度回调时预取在途必 no-op；取数失败的冷却仍走 `loadOlderRetryAfterMs`，不新增机制。
17. **`gate.cancel()` 只属于换会话，不属于换窗。** 换窗（`windowEpoch` 变化）必须让待提交请求活下来，并把它列入闸门 effect 的依赖：换代不改 `hasPendingOlder` / `loadingOlder`，漏掉就等于「丢掉请求且无人重挂」。任何 `cancel` 与「重新 request 的 effect」分属不同依赖集合的组合都是本规范的禁止形态——第 13 条的游标校验是换代路径唯一的作废入口。
18. **填充循环是上滚补页的唯一取数驱动者，中断信号是它唯一的重唤入口。** `loadOlder` 的每一条不落窗口的失败路径（纪元不匹配、事务锚点失配、取数失败）都必须 bump `olderFillInterruptedSeq`（store 单调递增信号）——静默 `return` 会让此刻闸门请求已被消费、缓冲状态不变、没有任何 effect 依赖发生变化，提交与取数同时无人唤醒（曾因此出现「正在加载更早消息」永久显示且列表滚不动）。填充循环与闸门 effect 都依赖该信号：信号变化 → 重新求值填充条件 → 未达丢弃上限则按新游标继续取页；连续丢弃达上限由 store 作废缓冲解锁（见 turn-window-fill 规则 11b），取数失败且缓冲非空则放行提交已取部分。

## staged 块就绪

### 落点

待插入的完整 turn 以 staged 态渲染进前插块容器（负偏移隐藏、真实宽度、参与布局）。测量与装载是**同一批节点**：staged 翻转成 committed 只是 wrapper 的 className 变化，key 不变，React 复用 DOM，渲染只发生一次。块的切分规则、容器结构、inset 记账见 `conversation-timeline-prepend-blocks.md`。

### 为什么它消除了漂移

块的行不经过虚拟列表的 `estimateSize`：翻转后它们留在块容器里，高度以容器实测进 `topInsetPx`，不存在「估值渲染 → 真值修正」的循环。全量进块后没有 trailing 行再走估算，提交帧的 totalSize 差值只反映窗口首轮被块收编后的长度变化（有符号、可负），不再承担任何新行高度。

### 就绪时机

构造性成立，无独立状态：`pendingOlderRows` 变化 → render/commit（staged DOM 挂载）→ 闸门 effect 随 `hasPendingOlder` 变化重跑并 `request(true, commit, 容器实时scrollTop)`。React 的 commit → effects 顺序保证闸门看到 staged 时它必然已挂载，也保证此时读到的 scrollTop 是布局终值；提交回调再按 `stagedPrependUnitsRef` 当场取 turn id。会倒退的就绪布尔是死锁温床（见产品规则第 7 条的事故），不再引入。

## 状态所有权

`ConversationProjectionStore` 是 `pendingOlder` 与提交裁决的唯一 owner。`ConversationTimeline` 是滚动状态与前插块状态（staged/committed 集合、容器高度、inset 账本）的唯一 owner。`timelinePrependCommit.ts` 不持有任何事实，只提供无 DOM/React 依赖的纯判定与排程。`timelineContentColumnClass.ts` 是内容列宽度类的唯一来源。

## 事件顺序

```text
用户接近顶部（离顶两视口）
  → loadOlder：rowsRange 在途，loadingOlder=true，占位块出现（inset 0 → h）
  → 列表仍可滚（锁还没落，见第 9 条），用户继续上滑
  → 行进 pendingOlder 缓冲（窗口未变）
  → splitPendingPageIntoBlockTurns 切出完整 turn，staged 渲染进块容器（负偏移，不可见，已布局）
  → 填充循环判定（turn-window-fill 规则 11）：不足一屏或边界轮未到齐 → 继续静默取页，
     缓冲与 staged 容器累积，期间占位块不显形（400ms 内）
  → 填充条件成立 + 用户抵达 scrollTop 0：占位块完整可见，锁落下
  → 闸门 effect 对账（账本 ← 容器实时 scrollTop）后排程下一个 task
  → flushSync 单笔：staged 翻转 + 并入窗口；prepend effect 在同一 commit 的 layout 阶段
     同步读块容器终值高度，scrollTop += (totalSize 增量 ?? 0) + inset 差值（一笔）
  → 占位块随 loadingOlder 消失，锁随 pending 清空而解除
```

矮内容序列（折叠后总高 < 视口）：

```text
打开会话（首轮窗口 + 折叠，内容不足一屏）
  → 消息层 ResizeObserver 回调评估预取（scrollTop 已为 0 ≤ 触发阈值，见第 16 条）
  → loadOlder 取数 → pendingOlder 缓冲 → staged 块渲染
  → 闸门 effect 对账读到 scrollTop=0（无 scroll 事件也放行，与「从未滚过」同效）
  → 下一个 task 单笔提交；提交后新内容仍不足一屏时由下一轮高度回调继续评估，
     直到内容可滚动或 hasOlderRows 为 false
```

## 负面边界

- **keyed prepend anchor（`prependVirtualAnchorAdjustment`）已退役删除。** 块路径的 Δ 来自装载 DOM 的同步实测，锚点推算没有存在必要；`loadAllOlder` 继续走 total-size fallback。
- **不压制 `shouldAdjustScrollPositionOnItemSizeChange`。** 提前量过之后它自然不触发；加抑制只会多一条需要维护的状态。
- **不把占位块做成合成虚拟项。** 那需要伪造字段齐全的 `ConversationTurnRenderUnit`（否则 `estimateConversationTurnHeight` 直接抛），并改动 5 处 `renderUnits.length` 语义（空态、贴底判定、跳转行数）。占位块留在消息层内、计入 `topInsetPx`。
- 不碰 `historyPrefetchTriggerPx` 的两视口阈值。
- 不碰 `loadAllOlder`。它只被回合导航器与分享只读态调用。
- 不复用 `backgroundScrollLocked`。那是分享选择面板的模态语义。
- 不引入 `content-visibility`。
- 不改存储层、协议层、冷恢复路径。

## 验收标准

1. 滚到顶部：占位块在列表内整列宽虚线框出现，**列表立刻滚不动**（滚轮、触摸、拖滚动条都无效）。
2. 占位块**出现之前**列表必须仍可滚：预取在离顶两视口就发出，若那时就冻住，用户永远到不了顶（本规范第 9 条的死锁）。
3. 保持不操作：内容到达后自动完成装载与高度调整，**全程不漂移、不跳位**，然后列表恢复可滚。
4. 占位块出现和消失的瞬间：下方正文**像素级不动**。
5. 前插后视口内**原来的那条消息仍在原位**，不跳到新页开头。
6. 前插中途想滚动：滚不动，不会出现「读到一半内容被拽走」。
7. 网络慢时占位块持续显示，期间反复尝试滚动无效；数据到达后一次性完成。
8. 窄屏（手机宽）staged wrapper 与真实列宽一致（含宽度过渡行为），行高不因换行差异而二次跳动。
9. 滚到一半（约一个视口）停住：不提交、不上锁，占位块在视口上方。
10. 会话切换 / rewind 裁剪后无残留占位块、无重复补偿。
11. 分享导入态（`headerSlot` 存在）下占位块与 headerSlot 叠加，高度补偿正确。
12. 底部 composer 在整个 pending 窗口不被顶开。
13. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `packages/ui` 全量测试通过。
14. 矮内容场景：折叠后不足一屏的会话打开后自动补页（无需任何滚动操作），占位块在内容落入后消失，不出现永久加载；补页轮次之间正文不跳位。
15. 滚到一半（约一个视口）停住时，对账值非顶 → 闸门不放行、不上锁，占位块在视口上方（与第 9 条一致，无行为变化）。
16. 活跃会话在补页缓冲挂起期间收到 snapshot 帧（换代）：占位块照常在内容落入后消失，不出现永久加载；换代后游标若已失配，按新游标重取而不是把这一页丢掉后无人重挂。
17. 上滚补页遇到被单帧上限拆开的巨轮：同一轮的「工具 N 次」不在可见区逐步上涨（填充条件拦住分批提交）；填充期间取数被丢弃或失败时，占位块与滚动锁在有限步内解除（丢弃达上限作废缓冲、失败提交已取部分），无请求自旋。

## 仍未处理

用户报告的「手机上偶尔抖一下」有两条候选成因。**测高竞态**（virtualizer 逐条改写 `scrollTop` + 用户锚点钉住，见 `conversation-timeline-user-scroll-anchor.md`）属于另一条代码路径：pending 窗口内列表锁死、`getVirtualItemForOffset` 在该窗口不被刷新，它在补页路径上应已失效；但它在流式输出、分享只读态等其他路径上是否仍存在，本次没有验证。若验收场景 3 之后仍有残余抖动，需单独排查后再决定是否动。

已知代价，本次接受不处理：`stagedPrependUnits` 依赖 `liveNowMs`，流式输出期间每秒重算一次 staged 帧。原「隐藏测量层把整页真实渲染两遍」的代价已随同位迁移消除——测量与装载是同一批节点。
