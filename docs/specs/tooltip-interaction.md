# Spec: Tooltip 默认不可交互

## 目标

公共 `TooltipContent`（`packages/ui/src/components/ui/tooltip.tsx`）直接透传 Radix 默认行为：气泡在关闭前的一瞬间仍参与鼠标命中测试。纯展示气泡因此会闪烁、偶发挡住触发器导致点击落空（10-06 自动化测试里记录过一次 tooltip 遮挡）。

本改动让默认气泡不再吃鼠标事件（`pointer-events-none`），气泡里真放了按钮、链接或必须滚轮滚动的 4 处显式 opt-in 保留交互。

## 产品规则

- **默认不可交互**：`TooltipContent` 的 `interactive` 属性默认为 false，为 false 时拼 `pointer-events-none`；同时 `Tooltip`（Root）的 `disableHoverableContent` 默认取反（`?? !interactive`），即默认关闭 Radix 的气泡悬停宽限区——鼠标离开触发器气泡即关闭，不会赖着不走。调用方显式传 `disableHoverableContent` 时以调用方为准。
- **例外标准**：只有气泡里放了 `button` / `a` / `input` 等可点击元素，或内容超出必须用滚轮滚动查看时，才允许传 `interactive`。纯文本、纯图标一律不传。
- **当前例外清单（共 4 处，只增不允许默减）**：
  1. `packages/ui/src/ToolCallBlocks/ToolLayout.tsx:292`——失败信息长，需一键复制排查。
  2. `packages/ui/src/WorkspaceSidebarItem.tsx:985`——远端连接失败错误栈，需在侧栏直接复制上报；长正文需滚轮查看。
  3. `packages/ui/src/UpdateReleaseNotesTooltip.tsx:30`——release notes 含超链接且内容长，需可点可滚。
  4. `packages/ui/src/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.tsx:91`——重连日志多行，需滚轮查看最新进展（无点击，仅滚动）。
- **新增例外必须同步更新本清单**：以后任何新增 `interactive` 的调用点，都要在本节追加一行说明理由。

## 接口

- `packages/ui/src/components/ui/tooltip.tsx`
  - `TooltipContent` 新增可选 `interactive?: boolean`（默认 false）。为 false 时 class 拼接追加 `pointer-events-none`；为 true 时保持现状。注释写明默认不可交互的原因与例外标准。
  - `Tooltip`（Root）新增同名可选 `interactive?: boolean`（默认 false），透给 Radix 的 `disableHoverableContent`（`?? !interactive`，调用方显式传值时以调用方为准）。默认关闭悬停宽限区，鼠标离开触发器即关闭。
- `packages/ui/src/ControlHintTooltip.tsx`
  - 新增同名透传 `interactive`（默认 false），同时透给 `Tooltip` 与 `TooltipContent`。全部约 77 处现有调用不改代码即享受不可交互（已逐个确认传的全是纯文本，无一处塞按钮或链接）。

## 状态与时序

无状态变化。`open` / `onOpenChange` / `delayDuration` / `side` / `align` 定位行为全部不动。`interactive` 只影响气泡层的鼠标命中，不改变打开与关闭时机。

## 负面边界

- `v4/SelectionActionMenu.tsx` 等名字带 Tooltip 的选中浮动菜单走 portal 且自带按钮，属于菜单语义，本次不碰。
- `PopoverContent`、`Dialog`、`DropdownMenu` 等真交互浮层不碰。
- recharts 的 `ChartTooltipContent`（`chart.tsx`）与 Radix Tooltip 无关，不碰。
- 不调整 `TooltipProvider delayDuration` 与任何定位行为。
- `UpdateReleaseNotesTooltip` 的外链点击在不可交互默认下会失效，因此它必须保留 `interactive`，不得跟随默认关闭。

## 验收场景

1. 任意 `ControlHintTooltip` 按钮上悬停出现气泡后，把鼠标移向气泡：气泡不阻挡，下层按钮可正常点击，气泡按原有失活逻辑关闭。
2. 工具调用失败行的状态 tooltip：悬停可见长文本，复制按钮可点击，复制后图标切换。
3. 远端连接失败 tooltip：长错误正文可用滚轮滚动，复制按钮可用。
4. 更新日志 tooltip：release notes 外链可点击，长文可滚动。
5. 重连日志 tooltip：多行日志可用滚轮查看最新行。
6. `pnpm typecheck` 通过，改动文件 lint 干净，相关单测全过。
