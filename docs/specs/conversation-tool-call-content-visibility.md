# Spec：工具卡的离屏渲染优化

## 目标

一条消息里出现上千条工具调用时，Electron 的滚动与交互明显变慢。本 spec 只引入浏览器原生的离屏渲染优化（`content-visibility: auto`），降低可视区之外工具卡的布局、样式计算与绘制成本。

本 spec **不**引入组件卸载、精确高度占位、工具卡粒度的虚拟列表，也不改动任何测量与测高链路。

## 现状与根因

会话时间线的虚拟化粒度是**整轮**（`ConversationTimeline.tsx` 的 `useVirtualizer`，`count` 是 turn 数量）。一轮内部若含上千条工具调用，虚拟器看不见它们——一轮就是一个超高 item。

轮内工具卡的挂载情况分两种：

- **历史轮**：`assistantHistoryDefaultOpen` 默认为 `false`（`conversationTurnRenderUnits.ts`），Radix `Collapsible` 收起时子内容不挂载，历史轮的工具卡默认不进 DOM。
- **运行中的轮**：`ConversationProcessRow` 用 `forceOpen={item.running}` 强制展开过程组，`nodes.map` 一次性挂载该组全部工具卡。此时上千张卡同时在 DOM 里。

`content-visibility: auto` 在本仓库已有两处使用：`code-block.tsx` 的通用代码块（`contain-intrinsic-size: auto 200px`）、`ConversationShareReadonlyTimeline.tsx` 的分享只读页整轮（固定 420px 占位）。正常会话的工具卡未启用。

## 产品规则

1. **落点是工具卡根节点**：`ToolCallBlocks.tsx` 的 `ToolCallBlockComponent` 根 `div`。这是所有工具卡的唯一收口处——过程组、工作行、explore 子工具、agent 子工具都经它渲染。挂在更靠上的位置会漏掉嵌套子工具；挂在 renderer 内部则每个 renderer 都要改一遍。

2. **属性固定为两行**：`content-visibility: auto` 加 `contain-intrinsic-size: auto 40px`。
   - `auto` 关键字让浏览器记住该元素上次渲染的真实尺寸，再次移出可视区时按记忆值占位；首次渲染前用 40px 兜底。
   - 40px 对应折叠态工具摘要行的高度（`timelineTurnHeightEstimate.ts` 的 `WORK_ROW_PX = 32` 加边框与间距）。

3. **不覆盖 `node-repl` 与 `mcp` 的既有豁免**。这两处已显式把代码块的 `content-visibility` 改回 `visible`、`contain-intrinsic-size` 改回 `none`，因为它们在 `max-h-72 overflow-auto` 的嵌套滚动容器里，Radix 折叠动画会按 200px 占位测高，导致先展开过头再回落。工具卡根节点在这两个 renderer 之外，不改变这两处的行为。

4. **不改任何测量链路**。本改动不引入 ResizeObserver、不改 `measureElement`、不改高度缓存、不改 `timelineTurnHeightEstimate`。

## 所有权与边界

- 工具卡根节点是本次离屏优化的唯一落点。样式常量集中在 `ToolCallBlocks.tsx` 内，不新建共享模块，不向 renderer 传递开关参数。
- 渲染器（`ToolCallBlocks/renderers/*`）不感知本优化。它们通过 `CodeBlock` 的 `style` 覆盖来表达自己的需要，这条通路保持不变。
- `ToolCallBlocks.tsx` 的 `renderContext`、memo 与 `ToolLayout` 的折叠逻辑不受影响。

## 不变量

1. 工具卡的 DOM 结构、事件绑定、测试标识不变。`data-testid`、`data-tool-call-id`、`data-tool-name`、`data-status` 仍在同一根节点上。
2. 工具卡的可见高度不因本改动改变。可视区内的工具卡按真实内容布局；离屏时按 `contain-intrinsic-size` 的记忆值或 40px 兜底占位。
3. 折叠动画的测高行为不变。本改动不触及 `ToolLayout` 与 `CollapsibleContent`，`--radix-collapsible-content-height` 的读取时机保持原样。
4. 浮层与定位后代的包含块不变。`content-visibility: auto` 隐含 `contain: layout`，会给绝对定位后代建立新的包含块。工具卡内部唯一的绝对定位后代是 `switch-mode.tsx` 的计划执行按钮，它已挂在自身的 `relative` 容器内，位置不受影响。

## 失败语义

- 浏览器不支持 `content-visibility` 时，属性被忽略，工具卡按普通方式布局，功能不受影响。Electron 41（Chromium 140）支持该属性。
- `contain-intrinsic-size` 的记忆值在窗口宽度变化后可能不再准确。宽度变化时浏览器会重新布局并更新记忆值，离屏卡片的占位在下一帧修正。

## 已知边界

- **离屏卡片的高度是估计值。** 工具卡首次渲染前按 40px 占位，宽度变化后记忆值会失准。这与整轮虚拟化的既有取舍同源：虚拟器本来就按估算高度记账，再由 `measureElement` 逐轮校正。
- **本改动不减少 React 渲染与 JS 开销。** 每张工具卡挂载时的 `JSON.parse`、Shiki 异步高亮、入场动画定时器（`ToolCallBlocks.tsx` 每卡两个 `setTimeout`）都不受 `content-visibility` 影响。Shiki 高亮本身已是异步且带 token 缓存，代码块也早已单独启用该优化。
- **paint containment 始终生效，内容会被裁到 padding box。** 工具卡根节点没有内边距，因此卡内溢出根节点的内容会被裁掉。当前工具卡子树内唯一的溢出候选是 `node-repl` 与 `mcp` 技术详情里的 `-ml-2` 按钮，它们位于 `CollapsibleContent` 的 `overflow-hidden` 之内，本就不可见。工具卡内的浮层（Dialog、Popover、Tooltip、Select、DropdownMenu）全部走 portal，挂在 body 上，不受此裁切影响。
- **`contain: layout` 改变绝对定位后代的包含块。** 工具卡内唯一的绝对定位元素是 `switch-mode.tsx` 的计划执行按钮，它已挂在自身的 `relative` 容器内，位置不变。后续新增渲染器若在卡外层放绝对定位元素，需自行确认位置。

## 验收

- 工具卡根节点带 `content-visibility: auto` 与 `contain-intrinsic-size: auto 40px`。
- 工具卡根节点的 `data-testid` 与 `data-tool-call-id` 保持不变。
- `node-repl` 与 `mcp` 的代码块豁免保持不变。
- 折叠动画与工具卡交互行为无回归。
- 类型检查、Lint、架构检查无新增失败。
