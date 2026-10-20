# Spec: 工具行失败详情的展示与交互

## 目标

工具行失败时把两件事分开：摘要行上留一个状态词「执行失败」（`chat.toolCall.status.failed`），错误详情（长文本 + 一键复制）挂在状态词的气泡里。约 30 个工具 renderer 的报错都汇流到这一个入口。

问题出在触发区：状态词是不可聚焦的 `span`，而 Radix `Tooltip` 的三条打开路径在触摸下全部落空——

- `pointermove` 路径对 `pointerType === "touch"` 直接 `return`；
- `focus` 路径要求触发区可聚焦，`span` 不是，而且手指点按也不会让它获得焦点；
- `click` 路径的语义是「关闭气泡」，不是打开。

结果是手机上用手指点「执行失败」什么也不会发生：气泡不开，失败原因看不到。桌面端靠悬停能看到，所以这个缺口只在触摸设备上暴露。

本 spec 规定失败详情在鼠标、触摸两类输入下的展示与打开规则，并把气泡的开关状态收口到一个所有者。

## 产品规则

- **状态词是失败详情的唯一入口**：摘要行上的失败状态词是虚线下划线，鼠标悬停或手指点按都能打开失败详情气泡。
- **桌面：悬停即开，移入气泡不关闭**：鼠标悬停状态词立即显示气泡；气泡可交互（内含复制按钮），鼠标从触发区移进气泡不会让气泡消失；移出后关闭。行为与改动前完全一致。
- **触摸：点按即开，再按或点外部关闭**：手指点按状态词打开气泡；再次点按状态词关闭；点按气泡外部关闭。触摸端没有悬停，不能沿用 hover 路径。
- **点按状态词不改变工具行的展开语义**：状态词位于摘要行的可展开区域内，点按它仍会像点击摘要行其他位置一样展开/收起工具行（桌面点击同样如此）。气泡打开与工具行展开可以同时发生。
- **气泡内容与外观沿用现状**：气泡浮在状态词上方、左对齐，宽度上限 `max-w-96`；错误正文最多 3 行（`line-clamp-3`），完整文本通过复制按钮取。
- **复制是气泡的一部分**：正文是字符串时气泡内显示复制按钮，点击复制完整错误文本；复制成功后图标切成对勾，1.5 秒后复原；复制失败弹 warning toast。
- **开关状态只有一个所有者**：气泡的 `open` 状态由状态词组件自己持有（受控 `open` / `onOpenChange`），Radix `Tooltip` 只负责定位、悬停宽限区与浮层行为，不再另开一条平行路径。
- **触摸判定只看指针类型**：以 `event.pointerType === "touch"` 为准，不看 `(hover: none)` 媒体查询。触屏笔记本这类同时支持 hover 的设备上，手指点按同样要能打开详情。鼠标路径由 Radix 自己按指针类型分流（`pointermove` 对 touch 直接返回），两条路径不会互相打架，因此不需要媒体查询兜底。
- **气泡默认仍可交互**：失败气泡是 `tooltip-interaction.md` 例外清单里的第 1 处（气泡内有按钮且正文长），不因本次改动降级为不可交互。

## 接口

- `packages/ui/src/ToolCallBlocks/ToolStatusWord.tsx`（新增）
  - `ToolStatusWord({ label, detail })`：`label` 为状态词节点；`detail` 存在时状态词成为气泡触发区，缺省时只渲染纯文字状态词。
  - 组件自持气泡 `open`（受控 Tooltip）、复制反馈状态、复制失败 toast。`ToolLayout` 不再持有这些状态。
- `packages/ui/src/ToolCallBlocks/toolStatusWordInteraction.ts`（新增）
  - `resolveFailureDetailPointerAction(pointerType)`：返回 `"open-and-keep"`（触摸：自己打开并挡住 Radix 的关闭语义）或 `"leave-to-radix"`（其余指针类型：完全交给 Radix 原有语义）。纯函数，供组件与单测共用。
- `packages/ui/src/ToolCallBlocks/ToolLayout.tsx`
  - 状态词渲染改为 `<ToolStatusWord label={statusLabel} detail={statusTooltip} />`；复制状态、复制定时器与复制逻辑从本文件移出。

## 状态与时序

状态所有者是 `ToolStatusWord` 组件实例：`open` 与 `copied` 两个 state，加上一个记录最近一次指针类型的 ref（`lastPointerTypeRef`）。

触摸首次点按的顺序：

1. `pointerdown`（`pointerType === "touch"`）→ 组件 `setOpen(true)`。同一事件里 Radix trigger 的 `onPointerDown` 读到的是本轮渲染的旧值 `open === false`，不会执行「已打开则关闭」。
2. 事件结束后 React 刷新，气泡挂载，`DismissableLayer` 挂上 document 级 `pointerdown` 监听（此时点按已结束，不会误关）。
3. `pointerup` → `click`：组件在 `click` 里 `preventDefault()`。Radix trigger 的 `click` 语义是「关闭气泡」，`composeEventHandlers` 检测到 `defaultPrevented` 后跳过它，气泡保持打开。

触摸再次点按状态词：

1. `pointerdown` → 组件 `setOpen(true)`（已是打开态，空转）；Radix trigger 的 `onPointerDown` 读到 `open === true`，执行关闭 → 气泡关闭。
2. `click` → 组件 `preventDefault()`，跳过 Radix 的重复关闭，最终仍是关闭态。

点按气泡外部：`DismissableLayer` 的 `onPointerDownOutside` → `onDismiss` → `onClose` → 关闭。

桌面悬停：Radix `pointermove` → `onOpen` → 受控 `onOpenChange(true)` → 组件写入 `open`；鼠标移出触发区后由气泡的悬停宽限区判定是否关闭。桌面点击状态词：Radix `onPointerDown` 见气泡已开 → 关闭（既有语义不变）。

## 负面边界

- **不引入键盘焦点位**：状态词仍是不可聚焦的 `span`，键盘用户打不开失败详情。摘要行本身是可聚焦的 `role="button"`，在它内部再插一个焦点位会造出嵌套可交互元素。这个缺口是既有的，本次不顺手改，需要单独对齐后再动。
- **不改工具行的展开规则**：状态词点按仍会连带展开/收起工具行，不为此在点按路径上吞掉冒泡。
- **不改气泡的定位、动画与样式**：浮层位置、宽限区、圆角、配色、`max-w-96` 宽度上限全部沿用现状。
- **不改失败状态词的判定**：哪些工具行显示「执行失败」、何时显示失败标签，仍由各 renderer 与 `ToolLayout` 的 `showStatusLabel` / `showFailureStatus` 决定。
- **不改其他 Tooltip 调用点**：除失败气泡外，其余 Tooltip 的交互与本次无关。

## 验收场景

1. 桌面端鼠标悬停失败状态词：气泡出现，显示错误正文；鼠标移进气泡点复制按钮，正文不被截断影响，复制成功后图标变对勾。
2. 桌面端鼠标点击失败状态词：气泡关闭，工具行展开——与改动前一致。
3. 触摸端手指点按失败状态词：气泡出现并显示错误正文（此前无任何反应）。
4. 触摸端再次点按失败状态词：气泡关闭。
5. 触摸端点按气泡外部：气泡关闭。
6. 触摸端点按气泡内的复制按钮：错误文本被复制，图标切换为对勾，气泡不因这次点按而关闭。
7. 失败详情不因为交互改动而改变显示时机：气泡关闭时错误正文不占据摘要行空间。
8. `pnpm typecheck` 通过，改动文件 lint 干净，`@zcode/ui` 包单测全过。
