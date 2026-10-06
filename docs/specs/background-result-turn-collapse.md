# Spec: 后台结果轮的过程行折叠

## 目标

后台 bash / 子代理 / workflow 任务跑完后，CLI 会另起一个 `origin: "backgroundResult"` 的「唤醒轮」。这个轮在会话里只渲染成一条裸标题行，下面把思考、工具、总结正文和后续行全部平铺，永远处于展开态——长会话里这类轮次一多，时间线就再也缩不回去。

本改动给唤醒轮的标题行接上折叠能力，让它和普通工作段表头观感一致：**收起后只剩一行标题，展开后回到原有的逐行呈现。**

```
收起态                                     展开态
┌──────────────────────────────┐         ┌──────────────────────────────┐
│ 后台运行一个每秒输出…的任务 › │         │ 后台运行一个每秒输出…的任务 ⌄ │
│ 后台任务跑完了，倒计时演示完整。│         │ 思考 1 次                      │
│ 编辑 1 次                      │         │ 后台任务跑完了，倒计时演示完整。│
│ 待办 缩短 fetching 文案  0/3   │         │ 编辑 1 次                      │
└──────────────────────────────┘         │ 待办 缩短 fetching 文案  0/3   │
                                          └──────────────────────────────┘
```

## 现状与根因

分叉点在 `ConversationTurnGroup.tsx` 的 `resolveBackgroundResultTitle(unit)`：轮头 `origin === "backgroundResult"` 且 `originMeta` 齐全（`workId` 与 `title` 非空、`backgroundSource` 属于 `bash` / `subagent` / `workflow` 白名单）时，整个轮交给 `ConversationBackgroundResultWork`，**绕开 `ConversationTurnFlow`**。而工作段表头 `AssistantHistoryStatus` 和它的 history 折叠全都住在 `ConversationTurnFlow` 里。

于是 `ConversationBackgroundResultWork` 把轮次拍平成四段平铺：

```
标题行（纯 div，无 trigger / 无 chevron）
assistantHistoryRows      ← 思考 N 次、工具行
latestAssistantTextRow    ← 唤醒总结正文
assistantFollowingRows    ← 编辑、待办
```

这不是漏写，是实现里写明的取舍：不复用普通 assistant 的工时折叠，因为那会显示不准确的分段耗时，并让一段短总结产生没有意义的收起态。

代价是两条分支的观感对不上。工作段表头提供三件东西——折叠区、chevron 提示、跑完自动收起——唤醒轮一件都没有；而两条分支的外壳又几乎逐字相同（都是 `flex w-full border-b border-[var(--color-border)]/50 pb-1` 的无图标文本行），肉眼会读成「同一个组件展开了没收起」，实际是两条互不相干的渲染路径。

本 spec 只把工作段表头已经证明可行的部分搬过来，不搬它带来争议的那部分（工时文案）。

## 产品规则

- **折叠区只盖 `assistantHistoryRows`**（思考、工具这类过程行）。`latestAssistantTextRow` 与 `assistantFollowingRows` 留在折叠区外无条件渲染。这与工作段严格同构：`buildConversationTurnWorkSegments` 也只把「最后一条正文之前」的行切进 `assistantHistoryRows`。**唤醒总结因此永远不会因为自动折叠而丢。**
- **默认态与工作段表头同源**：该轮 `isRunning` 为 true 时默认展开且不渲染 chevron（不可点）；`isRunning` 翻 false 的那一刻自动收起并显示 chevron。状态机照抄 `ConversationWorkSegmentFlow` 的 `useState(默认值)` + `useEffect` 按 `[默认值, key]` 复位。
  - 已知取舍：用户在运行中手动展开的选择会被收口时的自动收起覆盖。工作段表头今天就是这个行为，本改动不发明第二套规则。
- **没有任何过程行时不渲染折叠能力**：标题行保持纯 `div`，不渲染 trigger、不渲染 chevron、class 逐字不变。不给用户一个点开是空的入口。
- **workflow run 唤醒不参与**：`workflowNotification` 在场时走 `WorkflowNotificationToolRow`（`ToolLayout`，自带折叠），已经是可折叠的；再加一层会出现双重折叠。
- **标题行不加工时、工具次数、思考秒数。** `originMeta` 里没有这些字段，硬凑出来的正是当初注释里说的「不准确的分段耗时」；`formatWorkSegmentUsage` 也不该被套到一个没有 `workSegments` 事实的轮上。
- **展开态用组件本地 state，不写 `ToolLayout` 的模块级 `toolLayoutOpenState`。** 与工作段表头同款，不引入第二份展开态存储，也就不需要处理跨重挂载的持久化键。
- **不新增 i18n key。** 折叠区沿用既有文案，chevron 是纯装饰。
- **只改渲染层**：不改行数据、不改持久化、不改协议、不改 CLI。唤醒轮的行数据本来就齐（`isRunning` / `assistantHistoryRows` / `latestAssistantTextRow` / `assistantFollowingRows` 都是现成字段），缺的只是折叠。

## 接口

- `packages/ui/src/v4/ConversationTurnGroup.tsx`
  - 新增并导出 `ConversationBackgroundResultTitle({ title, testIdKey, open, canCollapse, onOpenChange })`，负责标题行的三种形态：纯 div / `CollapsibleTrigger` + `<button type="button">` / 同上且末尾补 `ChevronRightIcon`。导出是为了让 `renderToStaticMarkup` 能直接测。
  - `ConversationBackgroundResultWork` 增加 `useState` + `useEffect` 的展开态；裸标题分支从「标题行 + 平铺 history」改成 `Collapsible`（触发器 + `CollapsibleContent` 包住 history）+ 平铺正文 + 平铺 following。
  - 标题文本节点继续带 `TID_CHAT_BACKGROUND_RESULT_TITLE`，既有断言不受影响。
  - 折叠触发器是 `CollapsibleTrigger asChild`，`data-slot="collapsible-trigger"` 会自动合并到 button 上；`timelineToggleAnchor.ts` 的折叠锚点规则本来就按这个选择器匹配，不需要新加 test id。
- 间距常量复用 `HISTORY_CONTENT_DEFAULT_PADDING_CLASS`（`packages/ui/src/v4/conversationWorkItemGap.ts`）。

## 状态与时序

```
backgroundResult 轮
  ├─ workflowNotification 在场 ──▶ WorkflowNotificationToolRow（ToolLayout，自带折叠）
  └─ 裸标题分支
       ├─ 标题行（CollapsibleTrigger + chevron）
       ├─ CollapsibleContent ▸ assistantHistoryRows   ← 唯一被折叠的部分
       ├─ latestAssistantTextRow                      ← 常驻
       ├─ assistantFollowingRows                      ← 常驻
       └─ TurnChatLoadingSlot                         ← 常驻（在折叠区外）

展开态所有者：ConversationBackgroundResultWork 的组件本地 state
默认态来源：unit.isRunning
```

```
CLI 事件 ─▶ ProductProjection ─▶ turnHeader(origin=backgroundResult, originMeta)
         ─▶ buildConversationTurnWorkSegments（切 history / 正文 / following）
         ─▶ ConversationTurnGroupImpl ─▶ ConversationBackgroundResultWork
                                        └▶ 本地 state: isRunning ? open : 用户选择
```

## 间距约束

外层 `flex flex-col gap-3` **不能**承担标题↔折叠区那一段：flex gap 不属于 Radix 测量的 content 高度，收起到 0 后会在 `display:none` 的最后一帧再少一整段，下方内容看起来像闪没了。因此把 `pt-3` 放进 `CollapsibleContent` 内部那个容器的第一项（`HISTORY_CONTENT_DEFAULT_PADDING_CLASS`），由动画层承载——与 `ConversationWorkSegmentFlow` 处理 history chunk 的手法相同。折叠区塌成 0 高度时不留残余间距。

## 验收场景

1. 后台 bash 任务跑完 → 唤醒轮标题行右端出现 `>`，轮内「思考 N 次」收起，唤醒总结正文和它之后的「编辑 1 次」「待办」仍在折叠区外可见。
2. 唤醒轮还在流式出总结时（`isRunning=true`）→ 过程行默认展开，标题行不显示 chevron、点不动。
3. 轮次收口那一刻 → 过程行自动收起成「思考 N 次」一行，正文不受影响。
4. 点标题行展开 → 过程行出现；再点 → 收起。
5. 只有标题 + 正文 + 后续行、没有任何过程行的唤醒轮 → 标题行不带 chevron、不可点，渲染结果与改动前逐字一致。
6. workflow run 唤醒（`workflowNotification` 在场）→ 仍只渲染 `WorkflowNotificationToolRow` 通知卡，不出现第二层折叠。
7. 长会话滚到底后点标题行展开 → 被点的那行视口位置不动，展开内容开头不被 `h-14` 悬浮顶栏盖住。
8. 收起瞬间下方内容不出现多余空白块。
9. 英文界面下标题行与 chevron 渲染正常，无缺失文案。

## 未覆盖 / 已知取舍

- 用户在运行中手动展开的选择会被收口时的自动收起覆盖（与工作段表头一致）。
- 展开态只活在组件实例内，不跨重挂载持久化。唤醒轮寿命短、key 稳定，与工作段表头取同一取舍；真要让用户的选择跨冷恢复保留，需要引入持久键，属于另一件事。
- 收起态下过程行不挂载到 DOM（`CollapsibleContent` 的行为）。按 rowId 定位的行锚点在收起时不存在，展开后恢复。
- 分享只读页 `ConversationShareReadonlyTimeline` 没有 backgroundResult 分支，本改动不补。
- 交互层没有自动化验证：仓库没有 React 交互测试基建，本 spec 只做 `renderToStaticMarkup` 的形态断言，展开/收起与滚动锚点靠人工验收。
