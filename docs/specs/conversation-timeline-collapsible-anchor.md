# Spec: 时间线内折叠组的交互锚点（点哪留哪）

## 目标

时间线按「内容高度变化」裁决滚动：跟随中贴底。折叠组（「已工作 2 分 17 秒」这类历史状态行、工具卡片、过程汇总行）的展开/收起同样会改变内容高度，于是被这条规则接管——用户点开自己要看的那一块，动画期间逐帧贴底把刚点的行连续顶到视口上方；桌面端顶部还有 `h-14`（56px）的悬浮 Header，被顶上去的前一两行会被直接盖住，看起来像"内容飘走 / 锚点定到了 Header 上"。

本改动给这类交互一条独立语义：**点击折叠触发器是「保持我点的位置」，不是「跟着新内容走」**。

## 产品规则

- **触发点**：滚动容器内任意 `[data-slot='collapsible-trigger']` 的 `pointerdown`（ui 外壳 `components/ui/collapsible.tsx` 统一打这个槽位，`CollapsibleTrigger asChild` 会把它合并到子元素上）；另以 `[data-testid^='chat-assistant-history-trigger']` 兜底「已工作」历史行。工具卡片、历史状态行、过程汇总行都走同一个判定，不逐个打标。
- **保持锚点**：点击那一刻记下该元素相对滚动容器顶部的偏移；在作用窗口内，任何内容高度变化都不贴底，改为按偏移差抵消 `scrollTop`，让被点元素视觉上不动。
- **两种补偿口径，内容变化与用户滚动必须分开算**（本轮修复的根因）：
  - **内容变化口径**（`compensateToggleAnchor` 的 `content-change` 模式）：只补偿**内容自身**造成的位移，用**内容坐标**（视口偏移 + `scrollTop`）求差。视口偏移里混着用户自己的滚动量，若直接拿它求差，用户向下滚 250px 会被算成"内容位移 −250px"并写回 `scrollTop`，把用户拽回点击时的旧位置。内容坐标不含用户滚动量，因此用户滚动永远不会被补偿抵消。
  - **非用户滚动回退口径**（`scroll-restore` 模式）：焦点 scroll-into-view、virtualizer 晚到的修正等**不是用户滚动**的 `scroll` 事件，才按点击时的视口偏移还原锚点位置（视口坐标）。这两种口径不能混用：内容变化走内容坐标，非用户滚动回退走视口坐标。
- **用户主动滚动立即释放锚点**（双向）：用户向上滚（`awayFromBottom`）或向下滚（`towardBottom`）都表示用户接管了滚动位置，锚点必须让位——尤其向下滚：流式期间内容持续增长，锚点若还"保持"，"跟随贴底"被抑制，用户就永远停在离底一段距离的位置上。释放发生在**滚动意图登记时**（滚轮/触控板/键盘方向键，早于 `scroll` 事件），`scroll` 事件里再做一次同样裁决兜底；只认锚点登记**之后**发生的用户滚动，登记之前残留的旧滚动意图不能废掉刚建立的锚点。
- **指针交互中不释放**：手指按在屏幕上或指针按在滚动条上时，锚点不因用户滚动释放——这类交互期间的滚动可能来自按住拖动，与"用户主动接管滚动位置"不是一回事。
- **作用窗口**：`650ms`（300ms 折叠动画 + 虚拟列表收尾测高 + 焦点滚动补偿余量）。窗口结束即释放，不常驻。
- **三层防线**（缺一会复现「一点展开整段飘走」）：
  1. **贴底入口统一拦截**：`scrollToBottom` 在折叠锚点窗口内直接返回——内容 commit、宽度 resize 回调、会话内后续动作都进不来；窗口内 virtualizer 的测高补偿（`shouldAdjustScrollPositionOnItemSizeChange`）同样关闭，避免与手动锚点互拉 `scrollTop`。
  2. **scroll 事件写回**：窗口内的 `scroll` 事件若不是用户滚轮/拖拽（意图为 `none` 且指针未按在滚动条/触摸上），一律按**视口坐标**的偏移差写回——覆盖**焦点 scroll-into-view**（点击 button/div 聚焦时浏览器把元素对齐到滚动容器顶边，视觉上顶进悬浮顶栏）与 virtualizer 晚到的修正；用户主动滚动（向上或向下）则立即释放锚点，把滚动权交还用户。
  3. **焦点与停靠安全区**：折叠触发器鼠标按下时 `preventDefault` 不抢焦点（键盘 Tab 聚焦不受影响），从源头少一次滚动；触发器带 `scroll-mt-14`（对齐 `DesktopTopOverlay` 的 h-14），即便仍有原生滚动定位，也停在顶栏下方而不是被盖住。
- **不改跟随态**：窗口内不写 `following`，因此不闪「回到底部」按钮、也不改变流式期的跟随语义。滚动权仍只由真实用户滚动决定。
- **窗口续期**：巨型历史块（几十个工具行）展开/收起后，虚拟列表逐项实测高度会超过 650ms；过期后残余测高会被旧的贴底/测高校正接管，产生一次性大跳（展开跳到底、收起被甩到顶）。每次内容变化驱动的锚点补偿会把释放定时器往后推，但自点击起最多续到 `TIMELINE_TOGGLE_ANCHOR_MAX_WINDOW_MS`（3s）为止，防止流式期间永久霸占滚动权。
- **锚点元素失效守卫**：点击后锚点元素若被重渲染卸载（`getBoundingClientRect` 全 0），按偏移差补偿会算出垃圾修正量。补偿前先检测，失效即释放锚点，不写 `scrollTop`。
- **用户滚动测高校正让位**：折叠锚点窗口内，「用户滚动锚点校正」（`consumeUserScrollAnchorCorrection`）不得武装也不得消费——收起巨型历史块时它按过期 measurement 写 `scrollTop`，会算出巨大负修正量把页面甩到顶部。
- **不抢其它语义**：点击滚动条 / 容器空白的既有判定（登记为未知方向、按落点裁决）不变；内容区其它点击依旧不算滚动意图。
- **不改变贴底本身**：没有折叠锚点时，`following && !contentWidthChanging → 贴底` 的裁决完全照旧。

## 接口

`packages/ui/src/v4/timelineToggleAnchor.ts`（纯逻辑，无 DOM / React 依赖）：

- `TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR`：`[data-slot='collapsible-trigger']` + 历史行 test id 兜底。
- `TIMELINE_TOGGLE_ANCHOR_WINDOW_MS`：作用窗口 650ms。
- `TIMELINE_TOGGLE_ANCHOR_MAX_WINDOW_MS`：续期后自点击起的总窗口上限 3s。
- `extendedTimelineToggleAnchorDelayMs({ startedAt, now })`：续期后的定时器延时；超过总窗口上限返回 null。
- `isTimelineToggleAnchorDetached(rect)`：锚点元素是否已脱离文档流（rect 全 0）。
- `shouldSuppressTimelineScrollToBottom(toggleAnchorActive)`：贴底入口与 virtualizer 测高补偿是否让位。
- `shouldCompensateTimelineToggleAnchorOnScroll({ toggleAnchorActive, userScrollIntent, pointerScrollInteractionActive })`：窗口内 scroll 事件是否按锚点写回（只认非用户来源）。
- `timelineToggleAnchorAdjustment(recordedOffsetTop, currentOffsetTop): number`：钉住锚点所需的 `scrollTop` 修正量（**视口坐标**），亚像素（< 0.5px）返回 0 不写滚动。只用于非用户滚动的回退。
- `timelineToggleAnchorContentOffset({ viewportOffset, scrollTop })`：锚点元素在**内容坐标系**里的位置（视口偏移 + `scrollTop`），把用户自己的滚动量排除在外。
- `timelineToggleAnchorContentAdjustment(recordedContentOffset, currentContentOffset): number`：内容变化引起的 `scrollTop` 修正量（**内容坐标**），亚像素同样返回 0。
- `shouldReleaseToggleAnchorOnUserScroll({ toggleAnchorActive, userScrollIntent, pointerScrollInteractionActive, userScrollObservedAt, anchorStartedAt })`：用户主动滚动是否结束锚点。向上、向下都让位；指针交互中不释放；只认锚点登记**之后**发生的滚动。
- `resolveTimelineContentAnchorAction({ toggleAnchorActive, following, contentWidthChanging })`：内容变化后的动作，锚点生效期间恒为 `hold`，否则委托 `anchorActionAfterContentChange`。

`packages/ui/src/lib/timelineCollapsibleTriggerDom.ts`（供 v4 与 ToolCallBlocks 共用的 DOM 辅助）：

- `preventTimelineCollapsibleFocusScroll`：`mousedown` 主键 `preventDefault`，阻止聚焦触发的 scroll-into-view。
- `TIMELINE_COLLAPSIBLE_SCROLL_MARGIN_TOP_CLASS`：`scroll-mt-14` 顶部安全区。

`ConversationTimeline` 侧的接线：

- `handlePointerDownCapture` 识别折叠触发器并登记 `{ element, offsetTop, contentOffset, startedAt }` 与释放定时器（`clearToggleAnchor` 统一清理）。`contentOffset` 在登记时就算好，避免补偿时再取被用户滚动污染的视口偏移。
- `compensateToggleAnchor(element, mode)`：`mode` 为 `content-change`（内容变化，走内容坐标）或 `scroll-restore`（非用户滚动回退，走视口坐标）；读实测位置、算修正量、在 layout guard 内平移 `scrollTop` 并入账（`lastObservedScrollTop`）、同步目录视口与滚动记忆。
- `applyContentAnchorAction(following)`：统一裁决内容高度变化后的动作；锚点生效时调 `compensateToggleAnchor(element, "content-change")`，`scrollToBottom` 与 virtualizer 测高补偿各自在入口处让位。
- `markUserScrollIntent(intent)`：登记用户滚动意图；若该滚动发生在锚点登记之后且方向明确（向上或向下），立即 `clearToggleAnchor()`，把滚动权交还用户。
- `handleScroll`：scroll 事件里同样按 `shouldReleaseToggleAnchorOnUserScroll` 释放锚点；非用户来源的 scroll 事件调 `compensateToggleAnchor(element, "scroll-restore")` 把锚点放回点击时的视口位置。

## 状态与时序

```
pointerdown(折叠触发器)
  └─ 记录 { element, offsetTop, contentOffset, startedAt }，启动 650ms 释放定时器
click
  └─ Radix 切换 open，CollapsibleContent 挂载/卸载并播放 300ms 高度动画
       └─ 每帧虚拟列表测高 → totalSize 变化 → layout effect
            └─ applyContentAnchorAction(following)
                 ├─ 锚点生效 → "hold" → compensateToggleAnchor(element, "content-change")：
                 │    scrollTop += (实测内容坐标 - 记录内容坐标)，并续期窗口（上限 3s）
                 │    —— 用户自己的滚动量不在差值里，因此不会把用户拽回原位
                 └─ 无锚点   → 沿用裁决：跟随即贴底，否则保持
用户滚动（滚轮/触控板/键盘）
  └─ markUserScrollIntent → 若发生在锚点登记之后且方向明确 → clearToggleAnchor()
       └─ 锚点结束后，后续内容变化回到「跟随即贴底」：用户可以真正滚到底
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
7. **曾复现的循环（流式输出期间滚不到底）**：任务正在输出时，用户用触控板向下滚 → 滚动位置不再被拉回固定的旧位置，可以一路滚到真实底部；随后内容继续增长时按跟随贴底。
8. **用户下滚与内容增长同时发生**：用户在折叠动画期间向下滚 250px，内容在锚点上方增长 100px → 用户的滚动量完整保留，被点的那行仍按内容位移补偿（`scrollTop` 净增 100px）。

## 验证

- 单测：`packages/ui/test/timelineToggleAnchor.test.ts`（亚像素不写滚动、修正量方向、内容坐标换算与内容口径补偿、用户滚动双向释放裁决、锚点优先于贴底、贴底入口抑制、scroll 补偿只认非用户来源、选择器覆盖面）。
- 接线单测：`packages/ui/test/timelineUserScrollAnchorWiring.test.ts`（用户上下滚释放折叠锚点、手指按在屏幕上不释放、内容变化补偿不撤销用户下滚、内容在锚点上方增长时按内容坐标补偿、非用户滚动回退仍走视口口径）。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 未覆盖：真机（桌面 / Web）下的视觉确认——按验收场景 1 与 7 的步骤人工点击折叠组、并在流式输出期间用触控板下滚到底。
