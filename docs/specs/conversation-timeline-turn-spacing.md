# Spec: 会话时间线轮次间距

## 目标

一轮的 assistant 正文底部到下一轮用户气泡顶部，此前固定隔着 **120px**。本 spec 分两步收掉：

- **第一步（拆耦合）**：把 120px 收到 **80px**。其中 76px 是「hover 才显形的东西却常驻占位」加「一个数值同时干两件事」。轮间距归轮 `<section>`，顶栏避让归跳转路径，hover 操作行脱流。
- **第二步（收密度）**：轮内与轮间的 20px 档整体降到 12px、轮底降到 8px。**无轮尾块**（工具栏直接贴正文）的轮进一步收到 **56px**；**有轮尾块**（工具栏跟在文件变更摘要之类卡片后面）的轮停在 **80px**——多出来的 24px 正是补回卡片下方该有的留白，不算浪费。

轮内（轮顶 →「工作中」行）与有无轮尾块无关，从 151px 收到 **95px**，其中工作段表头的上边距归零。

## 产品规则

- **轮间距只有轮 `<section>` 一处所有者**。`<section>` 上的 `pt-*` / `pb-2` 是轮与轮之间唯一的节奏来源；轮内的行距归 [`conversationWorkItemGap.ts`](./conversation-turn-summary.md) 与 flow 容器，不参与轮间距。
- **顶栏避让不寄生在视觉留白里**。桌面顶栏 `DesktopTopOverlay` 是 `absolute left-0 top-0 z-20 h-14` 的覆盖层，时间线滚动容器自身没有任何顶部 padding。跳转落点必须由**跳转路径自己**减去 `TIMELINE_TOP_OCCLUSION_PX`（56），轮顶 padding 只负责视觉节奏。
- **轮顶 padding 分三态**：
  - 会话首轮（`startsTimeline`）→ `pt-14`（56px）。时间线最顶部就贴着顶栏区，首轮开头必须整段可见。
  - workflow 通知卡轮 → `pt-0`。中枢直接启动的轮由 run 卡呈现，没有用户气泡做视觉锚点，不占顶部留白。**这不等于它可以被顶栏盖住**：跳转偏移按它的 0 padding 照常补 56px。
  - 其余轮 → `pt-6`（24px）。
- **判定按 turn 在列表中的位置，不按挂载顺序**。虚拟滚动下首轮会反复卸载重挂，用「第一个挂载的」会让 `pt-*` 随滚动来回翻，既抖布局又让测量缓存失效。位置派生字段照 `isLastTurn` 的既有范式在第二遍统一落位。
- **轮级 hover 操作行不占文档流，但要从容器自己的底部留白里扣出来**。`group/assistant-turn` 容器内的轮尾操作行（`ConversationAssistantTextActions`，以及无正文时的 `hasHookActions` 分支）常态 `opacity-0`，却在流内实打实占 24px；又因为它是最后一个 flex 子项，还额外制造了一条 `gap`。两者合计 36px。
  - 脱流条件是**两个都要满足**：`rendersTurnTailActions`（`canRenderAssistantActions && latestAssistantTextRow` 或 `hasHookActions`）为真，**且** `unit.assistantTailRows.length === 0`。只看后者是不够的——工具栏压根不渲染时，定位类与内边距都成了凭空多出的空白。`assistantTailRows` 非空时它不是最后一个子项，必须保持流内，否则会压住轮尾 block。
  - 定位类与容器内边距是**一对**，缺一个就出重叠：
    - 定位祖先是 `group/assistant-turn` 上的 `relative`。
    - 纵向用 `bottom-0`，容器必须同时补足工具栏自身高度那一段。`bottom-0` 的语义是「元素底边贴容器底边」，只加定位类不补内边距，工具栏会往上盖住最后一块内容 24px（文件变更摘要就是这么被盖的）。
    - 横向用 `left-0` 不是 `right-0`：流内时这一行是 `flex-col` 的子项，默认 `align-items: stretch` 把它拉满整宽，而 `MessageActions` 没有 `justify-*`，按钮靠左排。改成右对齐是纯视觉回归。
  - **工具栏上方留多少，取决于它紧贴的是正文还是一张卡**。脱流后它下方的 `gap` 一起消失，内边距补多少要分两种情况：
    | 紧贴的对象 | 容器内边距 | 几何 | 理由 |
    |---|---|---|---|
    | 正文（无轮尾块） | `pb-6`(24) | 正文 → 0 → 工具栏 | 和正文旁边那排消息级小按钮一致，贴在一起反而和谐；正文本身已是可辨识的块，再加一段会把工具栏推成独立块 |
    | 卡片（有轮尾块） | `pb-9`(36) | 卡片 → 12 → 工具栏 | 卡片是独立块，上下都要留白；不补的话卡片变成「上面 12、下面 0」，头重脚轻 |
    - 「有没有轮尾块」由 `hasTurnTailBlocks` 判定，覆盖六类：完成卡、run 摘要、Cron 自动化卡、OffPeak 卡、文件变更摘要、轮尾截图。`assistantTailRows` 不在其中——它非空时工具栏压根不脱流。
    - ⚠️ **登记义务**：往 `group/assistant-turn` 里加新的轮尾块时必须同步登记进 `hasTurnTailBlocks`，否则新卡片下方会重新出现 0 间距。登记方式照 `hasAssistantTurnContent`——同一个容器上的同类并列判定，不是新模式。
  - **不借下一轮的顶部留白**。另一种更省的写法是让工具栏 `top-full` 挂到容器下面、占用 `section pb-2` + 下一轮 `pt-6` 合起来的 32px，能省满 36px。但下一轮若是 workflow 通知卡轮（`pt-0`），可用空间只剩 8px，工具栏会盖住那张卡顶部 24px。宁可少省也不要这条隐患。
  - `group-hover/assistant-turn` / `focus-within` 判定看 DOM 后代，绝对定位后仍是同一容器的后代，语义不变。
  - 净效果：无轮尾块的轮省 `gap(12) + 行高(24) − 内边距(24) = 12px`；有轮尾块的轮只省 12px（`gap` 那部分被补回去的 12 抵消）。
- **消息级 hover 操作行暂时仍占流，但不再叠上边距**。用户气泡底部与助手正文底部的 `MessageActions`（各 24px）本轮不脱流，原因是它们下面的间距不是常量：用户行的后继项间距由 `flowItemGapClass` 恒定返回 `WORK_ITEM_USER_GAP_CLASS`，助手行的后继项间距取 `pt-0.5`(2) / `pt-4`(16) / `pt-3`(12) 三种。绝对定位到气泡底必然压进下一块 2～22px。要回收这 48px 得先让「消息末尾」有一个可预测的专属间距槽位，属于另一件事。
  - 唯一动的是去掉两处的 `mt-1`（4px）：这一行常态不可见，上边距没有任何视觉作用。
  - 另有一条硬约束：`RowShell` 渲染的是裸 `<div>`，没有 `relative`。任何绝对定位必须自带定位祖先，否则 `top-full` 会一路向上找到轮 `<section class="relative">`，落点变成整轮底部。
- **20px 档整体降到 12px，但三档体系不变**。`2px`（过程连成一片）/ `12px`（分界：用户气泡与其后第一个助手块）/ `16px`（带边框外壳的卡独立成块）三档保留，只是把分界档从 20px 收到 12px。`WORK_ITEM_CARD_GAP_CLASS` 的 16px 不动——它是「块要独立成一段」的语义值，与用户抱怨的分界留白不是一件事。
- **工作段表头（`AssistantHistoryStatus`）不吃分界档，上边距为 0**。它自带 `border-b` 分隔线，上方是用户气泡这类已有边框的独立盒子，再叠一段外边距只是重复分段。实现走既有退出通道：给它的根节点挂 `mt-0` + `data-flow-gap`，让 `Collapsible` 那条 `[&>*+*…]:not([data-flow-gap])]:mt-3` 命中不到。
  - **只归零上边距**。下边距（表头与首个助手块之间那一段）仍走容器默认 12px——那是分隔线下的表格头到第一行数据，必须留白，否则首行会顶到分隔线上。两者一起归零会把表头压成一条糊在一起的横带。
  - 同一组件在两处渲染（`firstAssistantFlowItemIndex >= 0` 时作为首个助手 flow 项的兄弟节点，以及全部 flow 项都是用户输入时的尾部兜底），都吃这条规则，无需分别处理。
- **`WORK_ITEM_USER_GAP_CLASS` 与容器默认档必须同值**。带 `data-flow-gap` 的项用 `WORK_ITEM_USER_GAP_CLASS`（`mt-3`），未分类的项交回 `ConversationTurnGroup` 的 `[&>*+*…]:mt-3`，两者描述同一处留白。history 折叠外壳内的 `HISTORY_CONTENT_DEFAULT_PADDING_CLASS` 是第三处必须同步的副本（`pt-3`）。三处任一漂移，同一个分界会在带标记和不带标记的项上排出两个间距。
- **折叠历史内部的间距机制不归本 spec 管**。`[&>*+*…]:mt-*` 与 `FLOW_GAP_PADDING_CLASS` 的 `pt-*` 挂在 Radix 动画层内部，收起时随内容一起归零。本 spec 只改它们**同侧的数值**（`mt-5`→`mt-3`、`pt-5`→`pt-3`），`pt-*` 放在动画层内、`mt-*` 放在外壳上的分工不变，机制本身没动。相关规则见 [`conversation-turn-summary.md`](./conversation-turn-summary.md)。

## 接口

- 新增 `packages/ui/src/v4/timelineTopOcclusion.ts`（纯函数，无 DOM/React 依赖，与 `timelineTurnHeightEstimate.ts` 同风格）：
  - `TIMELINE_TOP_OCCLUSION_PX = 56`。对齐 `DesktopTopOverlay` 的 `h-14`。不从 DOM 实测：顶栏是 `absolute` 覆盖层不是占位块，实测需要额外 ResizeObserver，与该层既有的固定高度策略相悖。
  - `resolveTurnTopPaddingClass({ startsTimeline, startsWithWorkflowNotificationCard })` → `pt-14` / `pt-0` / `pt-6`。
  - `resolveTurnTopPaddingPx(...)` → `56` / `0` / `24`。
  - `resolveJumpOcclusionOffsetPx(...)` → `max(0, TIMELINE_TOP_OCCLUSION_PX − 该轮 padding)`。含义是「跳转落点还要额外下移多少，首行才不被顶栏盖住」。
- `packages/ui/src/v4/conversationTurnRenderUnits.ts`：`ConversationTurnRenderUnit` 增派生字段 `startsTimeline: boolean`。在 `normalizeRenderUnitPosition` 里按 kept 序列下标 `0` 计算，`resolveReusableTurnUnit` 的相等判定里带上它——与 `isLastTurn` 完全同构。位置变化时不复用，退化为重新落位。
- `packages/ui/src/v4/ConversationTurnGroup.tsx`：
  - 轮 `<section>` 的 `pt-*` 由内联三元改为 `resolveTurnTopPaddingClass(unit)`，并补 `scroll-mt-14`（复用 `TIMELINE_COLLAPSIBLE_SCROLL_MARGIN_TOP_CLASS` 同一语义），让未来任何走原生 `scrollIntoView` 的路径自动获得避让。
  - `group/assistant-turn` 容器加 `relative`，并在工具栏脱流时按 `hasTurnTailBlocks` 同步加 `pb-6`（贴正文）或 `pb-9`（跟卡片）；轮级操作行按上文条件改 `absolute bottom-0 left-0`。
  - 20px 档降到 12px 的四处：轮 `<section>` 的 `gap-5`→`gap-3` + `pb-5`→`pb-2`、`group/assistant-turn` 的 `gap-5`→`gap-3`、`ConversationTurnFlow` 根与 `ConversationBackgroundResultWork` 根的 `gap-5`→`gap-3`、`Collapsible` 的默认兄弟规则 `mt-5`→`mt-3`、`AssistantHistoryStatus` 的 `pb-2`→`pb-1` 且根节点加 `mt-0` + `data-flow-gap`（退出默认规则）。
- `packages/ui/src/v4/conversationWorkItemGap.ts`：`WORK_ITEM_USER_GAP_CLASS` `mt-5`→`mt-3`，`HISTORY_CONTENT_DEFAULT_PADDING_CLASS` `pt-5`→`pt-3`。`WORK_ITEM_CARD_GAP_CLASS`（`mt-4`/`pt-4`）与 `WORK_ITEM_TIGHT_GAP_CLASS`（`mt-0.5`/`pt-0.5`）不动。
- `packages/ui/src/v4/ConversationRowView.tsx`：两处消息级 `MessageActions` 去掉 `mt-1`。
- `packages/ui/src/v4/ConversationTimeline.tsx`：两条跳转路径接入 `resolveJumpOcclusionOffsetPx`，并同步 `lastObservedScrollTopRef` + `syncTurnNavigatorViewport`。
  - `scrollToUnit`：`virtualizer.scrollToIndex(unitIndex, { align: "start", behavior: "auto" })` 之后按目标轮偏移下移。
  - `scrollMountedQuery`：手算 `targetTop` 后减同一偏移。`scrollToQuery` 的未挂载兜底（同样走 `scrollToIndex({align:"start"})`）最终会落回 `alignMountedQuery` → `scrollMountedQuery` 的 rAF 重试，所以补偿只在一处发生，不叠加。
- 测试：新增 `packages/ui/test/timelineTopOcclusion.test.ts`（三态 padding + 偏移夹取）；`packages/ui/test/conversationTurnUnitReuse.test.ts` 补 `startsTimeline` 断言（前插更早历史后 `startsTimeline` 翻转、位置未变的轮仍复用同一对象）；`conversationWorkItemGap.test.ts` 锁 `mt-3`/`pt-3` 同值。

## 状态与时序

```
                 ┌─────────────────────────────┐
                 │ ConversationTimeline        │
   跳转目标 ────▶│ scrollToUnit /              │
                 │   scrollMountedQuery        │
                 └──────────┬──────────────────┘
                            │ 减 resolveJumpOcclusionOffsetPx(目标轮)
                            ▼
                   落点首行 ↓ 至少 56px
                            │
   DesktopTopOverlay ───────┤  h-14 = 56px 覆盖层
   (absolute, 非占位块)      │
                            ▼
                 ┌─────────────────────────────┐
                 │ 轮 <section>                │
   视觉节奏 ────▶│ pt-6 (24) / pt-14 (首轮)      │
                 │ pb-2 (8)                     │
                 │ └ group/assistant-turn      │
                 │   pb-6 / pb-9 接住脱流的工具栏 │
                 │    └ 轮级操作行              │
                 │      absolute bottom-0 → 0px │
                 └─────────────────────────────┘
```

## 间距账目

轮间（assistant 正文底部 → 下一条用户气泡顶部）分两种情况，因为工具栏上方留多少取决于有没有轮尾块。

**无轮尾块**（工具栏直接贴正文）：

| 段                            | 原      | 现     | 归属            |
| ----------------------------- | ------- | ------ | --------------- |
| `group/assistant-turn` 的 gap | 20      | 12     | 容器            |
| 轮级操作行                    | 24      | 0      | 脱流            |
| 工具栏上方                    | 12      | 0      | 随 gap 一起消失 |
| 容器补的 `pb-6`               | 0       | 24     | 容器            |
| `section` `pb-*`              | 20      | 8      | 轮 `<section>`  |
| 下一轮 `section` `pt-*`       | 56      | 24     | 轮 `<section>`  |
| **合计**                      | **120** | **56** |                 |

**有轮尾块**（工具栏跟在卡片后面）：

| 段                            | 原      | 现     | 归属           |
| ----------------------------- | ------- | ------ | -------------- |
| `group/assistant-turn` 的 gap | 20      | 12     | 容器           |
| 轮级操作行                    | 24      | 0      | 脱流           |
| 工具栏上方                    | 12      | 12     | 由 `pb-9` 补回 |
| 容器补的 `pb-9`               | 0       | 36     | 容器           |
| `section` `pb-*`              | 20      | 8      | 轮 `<section>` |
| 下一轮 `section` `pt-*`       | 56      | 24     | 轮 `<section>` |
| **合计**（不含卡片自身高度）  | **120** | **80** |                |

容器那两行的读法：`pb-*` 不是新增留白，而是把原本被工具栏占掉的那 24px 从「流内高度」搬到「内边距」，位置不变、文档流高度归零。无轮尾块时净省 12px（那 12px 的 gap）；有轮尾块时 `pb-9` 多出的 12px 正好补回被 gap 收走的 12px，净省 0——但换来了卡片下方不再被压成 0。

轮内（轮顶 →「工作中」行），与有无轮尾块无关：

| 段                              | 原      | 现     |
| ------------------------------- | ------- | ------ |
| 轮顶 `pt-*`                     | 56      | 24     |
| 用户行（气泡约 47 + 操作行 24） | 75      | 71     |
| 状态行上边距                    | 20      | 0      |
| **合计**                        | **151** | **95** |

- 预算是纯函数、无副作用，跳转路径自己调用，不进 React 状态。
- `startsTimeline` 只随「前插更早历史」这一个事件改变语义，那正是轮顶间距应该变的时候；滚动本身不改变它，因此不会引起测量抖动。
- 顶栏避让的补偿只发生在跳转落点计算处一处，prepend 锚点（`topInsetPx` = `headerSlotHeight + pendingHistorySlotHeight`）与之完全解耦，本改动不触碰。

## 负面边界

- 折叠历史内部的间距**机制**不动（外边距挂外壳、`pt-*` 挂动画层的分工），本 spec 只改数值，理由见产品规则末条。
- 消息级 `MessageActions` 的 24px × 2 不脱流，理由见产品规则。
- `WORK_ITEM_CARD_GAP_CLASS`（16px，带边框外壳的卡独立成块）不动。它是「块要独立成一段」的语义值，与被收紧的分界留白不是同一件事。
- `timelineTurnHeightEstimate.ts` 的常量表不加 padding 项。当前估算**不含**任何轮顶/轮底 padding，处于低估方向；本改动让真实高度下降，误差方向不变、量级变小。补表项属另一件事。
- `ConversationShareReadonlyTimeline.tsx:1049` 写死的 `gap-5 ... pb-5 pt-14` 不动：只读分享视图没有这些跳转路径、没有 hover 操作行、也没有折叠外壳。**这意味着分享页与应用内的密度会不一致**——是刻意留下的分界，不是遗漏；要统一需要单独评估分享页的布局契约。
- workflow 通知卡轮 `pt-0` 的既有取舍（跳转时首行曾被顶栏盖住）由 `resolveJumpOcclusionOffsetPx` 自然修好——公式对 0 padding 返回 56。这不额外加代码，但确实是超出「缩小空白」的行为变化。

## 验收

1. 桌面长会话（≥5 轮）滚到中段：助手正文底部到下一条用户气泡的间距从 120px 降到 56px（无轮尾块）或 80px（有轮尾块），肉眼可辨为「紧凑但不粘连」；用户气泡上方仍有明确留白。
2. 一轮末尾有文件变更摘要 / 完成卡这类轮尾块时，卡片**上下留白对称**（各 12px），不出现「上面 12、下面 0」。
3. 一轮末尾没有轮尾块时，工具栏直接贴住正文、0 间距，与正文旁边那排消息级小按钮的观感一致。
4. 会话内 find 搜索命中一条 query：落点行不被桌面顶栏遮住，文字完整可见。
5. 全局搜索结果跳进会话落到某一轮顶部：该轮首行不被顶栏遮住。
6. 开启轮目录（宽度 ≥864）点目录条跳到某轮 query 行：落点不被顶栏遮住。
7. hover 任意助手回复：复制 / 点赞 / 点踩 / fork 按钮出现在最后一块内容下方、**不压在任何内容上**（文件变更摘要、卡片、轮尾 block 都不能被盖住），hover 过程中不闪、不抖动。
8. 键盘 Tab 聚焦到操作按钮：按钮变为可见（`focus-within` 语义未破）。
9. 点击「工作中 N 秒」折叠行展开/收起：被点行位置不动（`scroll-mt-14` 仍生效），展开后首行不被顶栏遮住；展开态与收起态的行距一致，没有「收起时多算一段」的跳变。
10. 短会话（内容不足一屏）停在顶部：第一轮开头完整可见，不被顶栏遮住。
11. 顶部存在 history 补页占位块时跳转：落点不被占位块或顶栏遮挡。
12. 手机 Web（无 hover、操作行常显）：操作行仍可见，位置与改动前一致。
13. 一轮里有「工作段表头 + 正文 + 文件变更摘要 + 轮尾操作行」时，各块之间是 12px 的均匀节奏，没有某一段突然 20px 的洞。
14. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；`timelineTopOcclusion.test.ts`、`conversationTurnUnitReuse.test.ts`、`conversationWorkItemGap.test.ts`、`timelineTurnHeightEstimate.test.ts`、`timelineScrollAnchor.test.ts`、`timelineToggleAnchor.test.ts` 全绿。
