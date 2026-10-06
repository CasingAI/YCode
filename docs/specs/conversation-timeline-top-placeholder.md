# Spec: 对话时间线顶部加载占位块

## 目标

列表最顶端常驻一个**固定高度**的块：它是历史补齐的唯一几何锚点，也承载加载提示的透明度开关。块的高度永不变化，因此不再存在「出现/消失要补偿 `scrollTop`」这条链路。

## 现状与根因

三代形态：

```text
零高浮层：   sticky 绝对定位药丸，不在文档流、不参与记账
条件渲染块： loadingOlder 时 0 → 56px，出现/消失各要补偿一次 scrollTop
常驻块（本代）： 恒定 56px，永远在 inset 里；显隐只剩内容透明度
```

旧形态的显隐补偿由 `timelineTopInsetAdjustment` 统一计算，块出现时 `scrollTop += 56`、提交时 `scrollTop += Δ − 56`，还要与前插增量合成一笔（见 `conversation-timeline-prepend-blocks.md` 第 8 条）。快链路的补齐在几十毫秒内完成，这一来一回就是列表的一次轻微跳动——不是 bug，是记账本身在动。

## 产品规则

1. 占位块是消息层内一个真实占高度的块，排在 `headerSlot` 之前（它代表更早的内容），套用同样的 `contentWidthClassName` 与 `summaryPanelInlineOffsetClassName`。
2. **常驻渲染**：不再由 `shouldShowTimelineHistoryLoading` 条件渲染。`showHistoryLoading` 只剩一个用途——块内文字的透明度开关（见 `conversation-timeline-history-loading-indicator.md`）。
3. 块的高度是**固定值** `PENDING_HISTORY_SLOT_PX`（56px），常量进入 `topInsetPx`：`topInsetPx = headerSlotHeight + PENDING_HISTORY_SLOT_PX + prependBlocksHeight`。`appliedTopInsetRef` 账本不再需要为它结算（差值恒为 0）。
4. **首轮顶距让位**：首轮 `startsTimeline` 的 `pt-14`（56px）降为 `pt-0`——它与常驻块高度相同，由块承担。滚到真顶的总留白与改造前一致，贴底时用户看不到这一截。
5. 跳转落点补偿随之重算：`resolveJumpOcclusionOffsetPx` = `max(0, TIMELINE_TOP_OCCLUSION_PX − turnTopPadding)`，首轮 padding 归零后首轮跳转补满 56px，与其余轮的算法同构。
6. 块的宽度类由 `timelineContentColumnClass` 单一来源产出，与 staged 块 wrapper、真实内容列共用。
7. 保留 `TID_V4_TIMELINE_LOAD_OLDER`、`role="status"`、`aria-live="polite"`、`aria-atomic="true"`。

## 状态所有权

`ConversationTimeline` 是滚动坐标的唯一 owner：inset 高度、账本、写入点都在组件内。块本身没有状态——它的高度是常量，透明度由 `loadingOlder` 经延迟开关派生。

## 事件顺序

```text
任何时刻（会话有内容时）
  → 块常驻在消息层顶部，高 56px，进 scrollMargin
  → topInsetPx 的该项恒定，scrollTop 不因它产生任何写入
补齐进行中（首开静默补齐 / 上滚触发）
  → 块内文字按 400ms 延迟开关渐显/淡出，几何零变化
```

## 负面边界

- 不给占位块做圆角浮层、外发光、入场动画或零高模式：它在文档流里，任何装饰性位移都会变成一次真实的内容位移。
- 不做屏幕外预渲染，不引入 `content-visibility`（staged 块是为「预知高度」服务的真实渲染，与「屏幕外预渲染」不是一回事：它必须参与布局才能被量到）。
- 不给占位块加列表内虚拟行：它是普通文档流块，与 `headerSlot` 同级。
- 空会话（`renderUnits.length === 0`）不渲染该块：草稿居中布局不接受这 56px。

## 验收

1. 上滑到顶：顶部是一个在列表里的常驻块（有高度、有虚线描边、随内容列对齐）。
2. 任何补齐过程中，视口内已有内容的屏幕位置不发生变化（该块引起的 `scrollTop` 写入恒为 0）。
3. 滚到真顶的总留白与改造前一致；首轮 `pt-0`，块承担顶距。
4. 贴在底部时看不到该块。
5. 块高度固定，窄屏（320px）下内容截断而不换行、不撑高。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `packages/ui` 测试通过。
