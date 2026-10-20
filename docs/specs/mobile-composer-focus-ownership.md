# Spec: 移动端 composer 聚焦归属与时间线折叠展开的焦点让渡

## 目标

手机浏览器（Web 端 / 远控页）上，会话时间线里「收起的折叠块」（工具调用卡片、「已工作 X 分」历史行、文件摘要面板、计划/队列/推理等 `Collapsible` 抽屉）被点开时，系统软键盘会弹起并遮挡屏幕。用户的真实诉求是：**点开折叠块只想看内容，不该被输入框抢走焦点**。

根因不在折叠块本身，而在两处互相叠加的缺陷：

1. **移动端「自动聚焦跳过」的保护是死代码。** `packages/ui/src/v4/composer/composerAutoFocus.ts` 定义了「移动端 viewport 不自动聚焦」的规则，但唯一两个调用点（`packages/ui/src/v4/ConversationComposer.tsx` 的 `flushPendingFocus` / `requestComposerFocus`）读同一个 ref，该 ref 把 `isMobileViewport` 写死为 `false`。于是 `skip` 分支在手机上永远不可能命中，composer 在**挂载 / 切会话**时就把 DOM 焦点抢到了 contenteditable 上，手机随之拉起软键盘。
2. **折叠触发器主动阻止了焦点转移。** `packages/ui/src/lib/timelineCollapsibleTriggerDom.ts` 的 `preventTimelineCollapsibleFocusScroll` 在 `mousedown` 上 `preventDefault()`，本意是避免浏览器把焦点给触发器后触发 `scroll-into-view`（见 `docs/specs/conversation-timeline-collapsible-anchor.md`）。副作用是这次点击**既没把焦点移出 composer，也没让 composer 失焦**，焦点被钉在输入框上；展开引起内容高度变化与 `scrollTop` 补偿写回时，移动端 OS 会把仍处于焦点的 contenteditable 重新唤起软键盘。

本 spec 明确这两处的产品规则与边界：谁拥有焦点、什么时候让渡、让渡到哪里。

## 产品规则

### 一、移动端不自动聚焦 composer

- **判定口径**：移动端 = `isCoarseTouchDevice()` 为真（`(hover: none) and (pointer: coarse)`），即以触控为主要输入方式的设备。判定复用 `packages/ui/src/lib/pickerFocus.ts` 已有实现，不新增第二套断点。
  - 不用视口宽度（`useIsNarrowViewport` / 768px）作为口径：窄视口的桌面窗口没有软键盘，不该被剥夺自动聚焦；宽视口的手机（横屏、平板）同样有软键盘，不能因为宽度而豁免。
- **`skip` 的含义不变**：不聚焦，且**不暂存聚焦意图**（`pendingFocusRef` 不置位）。移动端不因为「暂时 disabled」而排队等一次聚焦——等来的那次聚焦同样会弹键盘。
- **移动端跳过的自动聚焦场景**（全部为「环境驱动」而非「用户驱动」）：
  - composer 挂载后的草稿恢复（scope 切换 effect 的 `applyDraft`）；
  - 切换会话 / 切换草稿导致的 scope 变化；
  - `draftFocusVersion` 变化（Cmd/Ctrl+N 与所有「新建任务」入口）。
- **移动端仍然允许的显式聚焦场景**（用户明确表达了「我要在这里输入」的意图，聚焦是操作的一部分）：
  - 队列项「撤回 / 编辑」恢复草稿到 composer（`applyComposerRestoreRequestToComposer`）；
  - 外部文本预填到 composer（`applyExternalTextInsertRequestToComposer`）；
  - 代码评论「加到对话」后回到输入框（`useCodeCommentContexts` 的 `requestFocus`）；
  - 工作区文件拖放进 composer。
  - 这四条路径复用现有的 `requestFocus` 回调，走**显式聚焦**通道，不受移动端跳过影响。
- **移动端聚焦 contenteditable 会拉起软键盘，这是预期行为**——显式聚焦场景下用户本来就要输入，键盘出现是正确的。

### 二、时间线折叠触发器的焦点让渡

- **折叠触发器点击后，composer 必须失焦。** 无论触发器是否带 `preventTimelineCollapsibleFocusScroll`，点击折叠块后焦点都不应留在 composer 的 contenteditable 上。
- **桌面端维持现状**：触发器通过 `onMouseDown → preventDefault()` 避免抢焦点带来的 `scroll-into-view`（顶部悬浮 Header 遮挡问题，见 `conversation-timeline-collapsible-anchor.md`）。桌面端 composer 失焦由触发器**自然接管焦点**完成（触发器是 `button` 或 `role="button" tabIndex={0}`，浏览器会聚焦它）。
- **移动端不能靠触发器自然接管**：触屏上 `mousedown` 的 `preventDefault()` 未必能阻止焦点转移，且不同触发器的 DOM 形态不一致（`button` / `div[role=button]`），焦点落点不可控。因此移动端**显式 `blur()` 当前 composer**，让焦点离开输入区、收起软键盘。
- **显式 blur 的落点**：不指定具体元素，只要求「焦点离开 composer」。实现上只在 `document.activeElement` 确实落在 composer 输入框内时调用 `blur()`，避免误伤其它输入框。
- **统一入口**：移动端 blur 挂在**时间线的折叠触发点**（`ConversationTimeline` 的 pointerdown 捕获，按 `TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR` 命中 `data-slot='collapsible-trigger'` 的触发器），而不是逐个折叠块各自接线。`CollapsibleTrigger` 在 `asChild` 时会把 `data-slot` 合并到子元素上，因此工具卡片、"已工作"历史行、文件摘要面板等时间线内折叠块**一处覆盖全部**。
- **一致性要求**：时间线内折叠触发器的 `preventTimelineCollapsibleFocusScroll` 覆盖必须补齐——原先只有 `ToolSummaryRow.tsx` 与 `ConversationTurnGroup.tsx`（两处）调用，`ConversationFileSummaryPanel.tsx` 缺失。缺失者不会触发 `scroll-into-view` 顶栏遮挡，但行为与同类折叠块不一致。

### 三、边界与不做的事

- **不改 `scroll-into-view` 的既有语义**：桌面端触发器不抢焦点的行为保留，`conversation-timeline-collapsible-anchor.md` 的锚点机制不动。
- **不改 composer 之外的聚焦行为**：行内编辑卡（`ConversationRowView` 的独立 `inputApiRef`）、弹层关闭回焦（`pickerFocus.ts` 的 `shouldRestoreChatInputFocusAfterPickerClose`）、设置项弹窗的 `autoFocus` 均不在本 spec 范围。
- **不引入新的断点或判定源**：移动端判定只用 `isCoarseTouchDevice()`；「是否为 composer 输入框」用既有 `data-testid` 定位，不新增测试 id 语义。
- **桌面端行为零变化**：`isCoarseTouchDevice()` 为假时，所有路径与改动前完全一致。

## 状态与事件顺序

```
移动端（isCoarseTouchDevice() === true）
  挂载 / 切会话 / 新建任务
    └─ requestComposerFocus()
         └─ resolveComposerAutoFocus({ autoFocusEnabled, disabled, isMobileViewport: true })
              └─ "skip" → 不聚焦、不置 pendingFocusRef → contenteditable 不拿焦点 → 不弹键盘

移动端 · 用户点开折叠块
  pointerdown（时间线捕获）
    └─ 登记折叠锚点（scrollTop 补偿，与焦点无关）
  mousedown
    └─ preventTimelineCollapsibleFocusScroll → preventDefault()（不抢焦点、不触发 scroll-into-view）
  click
    └─ Radix 切换 open → 内容高度变化
         └─ compensateToggleAnchor → 写回 scrollTop
  焦点处置（新增）
    └─ 显式 blur composer 的 contenteditable
         └─ 焦点离开输入区 → 软键盘收起 → 展开内容不被遮挡
```

```
桌面端（isCoarseTouchDevice() === false）
  挂载 / 切会话 / 新建任务
    └─ requestComposerFocus()
         └─ resolveComposerAutoFocus({ ..., isMobileViewport: false })
              └─ "focus-now" → rAF → inputApiRef.current.focus() → contenteditable 拿焦点（不变）
  点开折叠块
    └─ 触发器自然接管焦点（button / role=button）→ composer 失焦（不变）
```

## 接口

- `packages/ui/src/v4/composer/composerAutoFocus.ts`
  - `resolveComposerAutoFocus({ autoFocusEnabled, disabled, isMobileViewport, intent })`：三态判定不变（`focus-now` / `defer` / `skip`）。`intent` 为 `"ambient"`（默认，环境驱动）或 `"explicit"`（用户驱动）；`isMobileViewport` 为真时只跳过 `ambient`，`explicit` 照常聚焦。
  - `intent` 与 `ComposerAutoFocusIntent` 类型一并导出。
- `packages/ui/src/v4/ConversationComposer.tsx`
  - `focusOptsRef` 只保留 `autoFocusEnabled` / `disabled`（渲染期入参）；`isMobileViewport` 在**决策时刻**由 `isCoarseTouchDevice()` 求值，不在每次渲染都跑 `matchMedia`。
  - `pendingFocusRef`（布尔）改为 `pendingFocusIntentRef`（`ComposerAutoFocusIntent | null`）：移动端只有 `explicit` 意图才允许兑现，`ambient` 在移动端直接 `skip`、不暂存意图。已有 `explicit` 意图不被后续 `ambient` 请求降级。
  - 新增 `requestComposerFocusExplicit`：承载队列撤回恢复、外部文本预填、代码评论「加到对话」三条用户驱动路径。
- `packages/ui/src/lib/pickerFocus.ts`
  - 新增 `shouldBlurComposerOnCollapsibleToggle({ isCoarseTouchDevice })`：移动端返回 true，桌面端返回 false。纯函数，便于单测。
- `packages/ui/src/lib/timelineCollapsibleTriggerDom.ts`
  - `preventTimelineCollapsibleFocusScroll` 语义不变（仍是阻止抢焦点）。
  - 新增 `blurComposerInputOnMobileToggle()`：移动端且焦点确实落在 composer 输入框内时 `blur()` 它。
- `packages/ui/src/v4/ConversationTimeline.tsx`
  - 折叠触发点（pointerdown 捕获命中 `TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR`）调用 `blurComposerInputOnMobileToggle()`，一处覆盖时间线内全部折叠块。
- `packages/ui/src/v4/ConversationFileSummaryPanel.tsx`
  - 补 `onMouseDown={preventTimelineCollapsibleFocusScroll}`，与同类折叠块行为一致。

## 验收场景

1. **主场景（用户报的 bug）**：手机浏览器打开会话 → 页面加载完成 → **输入框没有获得焦点，软键盘没有弹出**。
2. 手机上点开工具调用卡片 / 「已工作 X 分」历史行 / 文件摘要面板 / 计划卡 → **输入框失焦，软键盘保持收起**，展开内容完整可见。
3. 手机上点开折叠块后，**可以正常点输入框**并唤起软键盘输入。
4. 桌面端：切会话 / 新建任务 → 输入框**仍然自动获得焦点**（行为零变化）。
5. 桌面端：点开折叠块 → 触发行仍然不抢焦点、展开内容开头不被悬浮顶栏盖住（`conversation-timeline-collapsible-anchor.md` 的验收场景 1 仍然成立）。
6. 移动端 + 队列项「撤回」→ 草稿恢复到 composer **并且**获得焦点（显式聚焦路径未被移动端跳过规则误伤）。
7. 移动端 + 点击示例提示词 / 代码评论「加到对话」→ 同样获得焦点。

## 验证

- 单测：
  - `packages/ui/test/composerAutoFocus.test.ts`（新增）：三态判定——桌面端 ambient 在可编辑时 `focus-now`、disabled 时 `defer`；移动端 ambient 一律 `skip`（含 disabled，不暂存意图）；移动端 explicit 在可编辑时 `focus-now`、disabled 时 `defer`；`autoFocusEnabled=false` 一律 `skip`。
  - `packages/ui/test/mobileComposerFocusOwnership.test.ts`（新增）：`shouldBlurComposerOnCollapsibleToggle` 的桌面/移动端取值。
- 接线单测：`packages/ui/test/mobileComposerFocusWiring.test.ts`（新增）：断言 `ConversationComposer.tsx` 不再把 `isMobileViewport` 写死为 `false`、三条用户驱动路径走 `requestComposerFocusExplicit`、且 `ConversationTimeline.tsx` 的折叠触发点调用了 `blurComposerInputOnMobileToggle()`。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 未覆盖：真机（iOS Safari / Android Chrome）下的视觉确认——按验收场景 1、2、3 人工在手机上点开折叠块，确认软键盘保持收起。
