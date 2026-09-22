# Spec: 时间线内折叠组的交互锚点（点哪留哪）

## 目标

时间线按「内容高度变化」裁决滚动：跟随中贴底。折叠组（「已工作 2 分 17 秒」这类历史状态行、工具卡片、过程汇总行）的展开/收起同样会改变内容高度，于是被这条规则接管——用户点开自己要看的那一块，动画期间逐帧贴底把刚点的行连续顶到视口上方；桌面端顶部还有 `h-14`（56px）的悬浮 Header，被顶上去的前一两行会被直接盖住，看起来像"内容飘走 / 锚点定到了 Header 上"。

本改动给这类交互一条独立语义：**点击折叠触发器是「保持我点的位置」，不是「跟着新内容走」**。

## 产品规则

- **触发点**：滚动容器内任意 `[data-slot='collapsible-trigger']` 的 `pointerdown`（ui 外壳 `components/ui/collapsible.tsx` 统一打这个槽位，`CollapsibleTrigger asChild` 会把它合并到子元素上）；另以 `[data-testid^='chat-assistant-history-trigger']` 兜底「已工作」历史行。工具卡片、历史状态行、过程汇总行都走同一个判定，不逐个打标。
- **保持锚点**：点击那一刻记下该元素相对滚动容器顶部的偏移；在作用窗口内，任何内容高度变化都不贴底，改为按偏移差抵消 `scrollTop`，让被点元素视觉上不动。
- **作用窗口**：`650ms`（300ms 折叠动画 + 虚拟列表收尾测高 + 焦点滚动补偿余量）。窗口结束即释放，不常驻。
- **三层防线**（缺一会复现「一点展开整段飘走」）：
  1. **贴底入口统一拦截**：`scrollToBottom` 在折叠锚点窗口内直接返回——内容 commit、宽度 resize 回调、会话内后续动作都进不来；窗口内 virtualizer 的测高补偿（`shouldAdjustScrollPositionOnItemSizeChange`）同样关闭，避免与手动锚点互拉 `scrollTop`。
  2. **scroll 事件写回**：窗口内的 `scroll` 事件若不是用户滚轮/拖拽（意图为 `none` 且指针未按在滚动条/触摸上），一律按偏移差写回——覆盖**焦点 scroll-into-view**（点击 button/div 聚焦时浏览器把元素对齐到滚动容器顶边，视觉上顶进悬浮顶栏）与 virtualizer 晚到的修正；用户主动滚动（尤其 `awayFromBottom`）则立即释放锚点，把滚动权交还用户。
  3. **焦点与停靠安全区**：折叠触发器鼠标按下时 `preventDefault` 不抢焦点（键盘 Tab 聚焦不受影响），从源头少一次滚动；触发器带 `scroll-mt-14`（对齐 `DesktopTopOverlay` 的 h-14），即便仍有原生滚动定位，也停在顶栏下方而不是被盖住。
- **不改跟随态**：窗口内不写 `following`，因此不闪「回到底部」按钮、也不改变流式期的跟随语义。滚动权仍只由真实用户滚动决定。
- **不抢其它语义**：点击滚动条 / 容器空白的既有判定（登记为未知方向、按落点裁决）不变；内容区其它点击依旧不算滚动意图。
- **不改变贴底本身**：没有折叠锚点时，`following && !contentWidthChanging → 贴底` 的裁决完全照旧。

## 接口

`packages/ui/src/v4/timelineToggleAnchor.ts`（纯逻辑，无 DOM / React 依赖）：

- `TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR`：`[data-slot='collapsible-trigger']` + 历史行 test id 兜底。
- `TIMELINE_TOGGLE_ANCHOR_WINDOW_MS`：作用窗口 650ms。
- `shouldSuppressTimelineScrollToBottom(toggleAnchorActive)`：贴底入口与 virtualizer 测高补偿是否让位。
- `shouldCompensateTimelineToggleAnchorOnScroll({ toggleAnchorActive, userScrollIntent, pointerScrollInteractionActive })`：窗口内 scroll 事件是否按锚点写回（只认非用户来源）。
- `timelineToggleAnchorAdjustment(recordedOffsetTop, currentOffsetTop): number`：钉住锚点所需的 `scrollTop` 修正量，亚像素（< 0.5px）返回 0 不写滚动。
- `resolveTimelineContentAnchorAction({ toggleAnchorActive, following, contentWidthChanging })`：内容变化后的动作，锚点生效期间恒为 `hold`，否则委托 `anchorActionAfterContentChange`。

`packages/ui/src/lib/timelineCollapsibleTriggerDom.ts`（供 v4 与 ToolCallBlocks 共用的 DOM 辅助）：

- `preventTimelineCollapsibleFocusScroll`：`mousedown` 主键 `preventDefault`，阻止聚焦触发的 scroll-into-view。
- `TIMELINE_COLLAPSIBLE_SCROLL_MARGIN_TOP_CLASS`：`scroll-mt-14` 顶部安全区。

`ConversationTimeline` 侧的接线：

- `handlePointerDownCapture` 识别折叠触发器并登记 `{ element, offsetTop }` 与释放定时器（`clearToggleAnchor` 统一清理）。
- `compensateToggleAnchor(element)`：读实测偏移、算修正量、在 layout guard 内平移 `scrollTop` 并入账（`lastObservedScrollTop`）、同步目录视口与滚动记忆。
- `applyContentAnchorAction(following)`：统一裁决内容高度变化后的动作；`scrollToBottom` 与 virtualizer 测高补偿各自在入口处让位。

## 状态与时序

```
pointerdown(折叠触发器)
  └─ 记录 { element, offsetTop }，启动 400ms 释放定时器
click
  └─ Radix 切换 open，CollapsibleContent 挂载/卸载并播放 300ms 高度动画
       └─ 每帧虚拟列表测高 → totalSize 变化 → layout effect
            └─ applyContentAnchorAction(following)
                 ├─ 锚点生效 → "hold" → compensateToggleAnchor：scrollTop += (实测偏移 - 记录偏移)
                 └─ 无锚点   → 沿用裁决：跟随即贴底，否则保持
400ms 后：释放锚点 → 后续内容变化回到原语义
```

唯一所有者：折叠锚点由 `ConversationTimeline` 持有（`toggleAnchorRef` / `toggleAnchorTimerRef`）；折叠组自身不持滚动状态，因此不会与时间线的底部锚定状态机争 `scrollTop`。

## 验收场景

1. **主场景（曾复现的 bug）**：先滚到底部（`following=true`），屏幕中间是一个可展开的「已工作 X」块 → 点击展开：被点的状态行视口位置不动，展开内容开头不被悬浮顶栏盖住，整段不再上飘。
2. 同样条件下收起 → 状态行原地不动，下方内容向上收。
3. 用户已上滚（`following=false`）时点击折叠 → 行为与改动前一致（本来就不贴底）。
4. 焦点滚动兜底：即便触发器仍被浏览器聚焦滚动（如键盘 Tab），`scroll-mt-14` 让停靠点落在顶栏下方，窗口内的 scroll 事件仍会被写回锚点。
5. 点击滚动条 / 容器空白 → 仍登记未知方向并按落点裁决，不被折叠锚点接管；用户在窗口内主动滚轮离开 → 锚点立即释放。
6. 未点击任何折叠触发器时，流式新增内容在有跟随权的情况下照旧贴底。

## 验证

- 单测：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/timelineToggleAnchor.test.ts`（亚像素不写滚动、修正量方向、锚点优先于贴底、贴底入口抑制、scroll 补偿只认非用户来源、选择器覆盖面）。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 未覆盖：真机（桌面 / Web）下的视觉确认——按验收场景 1 的步骤人工点击折叠组并观察被点行是否保持不动。
