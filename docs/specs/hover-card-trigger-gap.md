# Spec: HoverCard 保留视觉留白且跨留白命中连续

## 目标

composer 工具栏的上下文用量圆环、子代理底栏的上下文圆环都用 Radix HoverCard 展示额度面板。
面板与触发器之间需要保留 2px 视觉留白，但用户把指针从圆环慢速移向面板时不能中途消失。

上一版把面板下沿压到 14px 圆环图标的上沿（`sideOffset` 为 -7 / -9），虽然消除了命中空档，
但面板压住触发器的透明内边距，视觉上过于贴脸，用户不接受。本次恢复 2px 留白，并用触发器
自带的透明命中桥跨过这段留白。

## 根因

Radix HoverCard（`@radix-ui/react-hover-card` 1.1.x）在触发器 `pointerleave` 时调用
`handleClose()`，用 `setTimeout(..., closeDelay)` 排入关闭；内容 `pointerenter` 才会清掉
该计时。它没有安全多边形（safe polygon；只有 Radix Tooltip 提供，Popover 也没有）。共享 `Context`
root 默认 `openDelay=0`、`closeDelay=0`。

触发器与面板之间留出空档时，指针慢速移动会先落在空档里：触发器 `pointerleave` 触发，
`closeDelay=0` 的计时在下一轮宏任务到点并关闭面板，指针还没碰到面板。移动快时一次命中测试
直接跨过空档，所以只有慢速移动复现。

## 几何与裁剪约束

### 按钮 border box 与绝对定位包含块

`Button` 基础类含 `border border-transparent`（1px）。绝对定位伪元素的包含块是按钮的
padding box，比 border box 内缩 1px 且窄 2px。若使用 `inset-x-0` + `bottom-full` /
`top-full`，命中桥实际宽度只有 border box 宽度减 2px，垂直方向只到 padding box 边缘，
无法覆盖完整 2px 留白和承诺的 1px 重叠。

因此伪元素必须相对 padding box 外扩 1px：

```text
before: -inset-x-px  bottom-[calc(100%+1px)]  h-[3px]
after:  -inset-x-px  top-[calc(100%+1px)]     h-[3px]
```

- 宽度 = padding box 宽度 + 2px = 按钮 border box 宽度（含 1px border）。
- 上（下）边缘 = 按钮 border box 外沿；3px 中 2px 跨留白、1px 与面板重叠。
- 不修改按钮 border，避免改变视觉尺寸或影响其它按钮。

### composer 紧包 span 的裁剪

`ConversationComposer.tsx` 主调用点用

```tsx
<span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
```

紧包 `V4ComposerModelControls`。该 span 的高度就是 28px 触发器高度，`overflow-hidden`
会同时裁剪 X 和 Y，把上下伪元素命中桥整段裁掉。只把该 span 改为
`overflow-x-clip overflow-y-visible`：

- X 保持 `clip`，窄屏下模型控件仍被裁剪，不改变既有布局。
- Y 改为 `visible`，命中桥和面板不被 span 裁剪。`clip` 与 `visible` 是 CSS 允许的组合，
  `visible` 不会被计算成 `auto`，不会产生滚动容器。
- 仅改这一处紧包 span；不扩大到其它 `overflow-hidden` 容器，也不改按钮 border。
- 子代理底栏与编辑卡复用的 `V4ComposerModelControls` 上层没有同高度的紧包裁剪容器，
  不属于本次改动；编辑卡根节点的 `overflow-hidden` 用于圆角裁剪，保持不动。

## 产品规则

- **保留 2px 视觉留白**：`ContextContent` 的 `sideOffset` 固定为
  `CONTEXT_PANEL_TRIGGER_GAP_PX = 2`，面板与触发器不再重叠，也不贴住圆环图标。
- **命中桥归触发器所有**：`ContextTrigger` 开启 `hitBridge` 时，用 `::before` / `::after`
  在触发器上方和下方各铺一条透明命中条，高度为 `CONTEXT_TRIGGER_HIT_BRIDGE_PX = 3`
  （2px 留白 + 1px 与面板重叠，避免亚像素定位产生新缝隙）。
- **命中桥不横向扩张**：宽度严格等于触发器 border box 宽度（含 1px border）。指针横向移向
  邻近控件时必须离开命中区，面板按既有语义关闭。
- **紧包容器保留 X 裁剪、放开 Y**：composer 主调用点的紧包 span 使用
  `overflow-x-clip overflow-y-visible`，既保留窄屏 X 裁剪，又不裁掉上下命中桥。
- **命中桥不新增状态**：它只是触发器的 CSS 子盒，`pointerleave` / `pointerenter` 的归属仍是
  触发器本身。两处宿主各自拥有 `contextOpen`，Radix 通过 `onOpenChange` 请求更新，
  不维护第二份受控打开状态。
- **只对精细指针生效**：命中桥类名以 `pointer-fine:` 媒体查询限定。触摸设备不扩大点击热区，
  触摸打开仍走 `ContextTrigger` 的 `pointerdown` 受控入口。
- **上下双侧覆盖碰撞翻转**：面板在 `top` 时由 `::before` 覆盖上方留白，碰撞 `flip` 到 `bottom`
  时由 `::after` 覆盖下方留白；`shift` 只改变水平位置，不影响垂直连续性。
- **不用 closeDelay 兜底**：不得靠增大 `closeDelay` 掩盖几何空档。
- **不实现全局 safe polygon**：只为这两处上下文浮层加有界命中桥，不引入跨组件的多边形跟踪。

## 接口

### `packages/ui/src/components/ai-elements/context.tsx`

- 删除 `resolveContextPanelSideOffset`（负偏移方案已废弃）。
- 新增并导出：
  - `CONTEXT_PANEL_TRIGGER_GAP_PX = 2`：面板与触发器的视觉留白。
  - `CONTEXT_TRIGGER_HIT_BRIDGE_PX = CONTEXT_PANEL_TRIGGER_GAP_PX + 1`：命中桥高度。
- `ContextTriggerProps` 新增可选 `hitBridge?: boolean`，默认 `false`：
  - 默认值保持不变，不影响未启用该属性的使用点。
  - 仅作用于默认按钮渲染；传入自定义 `children` 时调用方需自行提供命中桥。
  - 启用时按钮增加 `relative`、上下各 3px 的 `pointer-fine` 伪元素，以及
    `data-context-trigger-hit-bridge="true"` 标记。伪元素用 `-inset-x-px` 和
    `bottom-[calc(100%+1px)]` / `top-[calc(100%+1px)]` 对齐按钮 border box。

### 调用方

- `packages/ui/src/chat-input-toolbar/contextUsage.tsx`
  - 删除 `CONTEXT_TRIGGER_HEIGHT_PX`。
  - `ContextTrigger` 加 `hitBridge`。
  - `ContextContent` 的 `sideOffset` 改为 `CONTEXT_PANEL_TRIGGER_GAP_PX`。
- `packages/ui/src/v4/SubagentStatusFooter.tsx`
  - 删除 `CONTEXT_TRIGGER_HEIGHT_PX`。
  - `ContextTrigger` 加 `hitBridge`。
  - `ContextContent` 的 `sideOffset` 改为 `CONTEXT_PANEL_TRIGGER_GAP_PX`。
- `packages/ui/src/v4/ConversationComposer.tsx`
  - 仅把紧包 `V4ComposerModelControls` 的 span 从 `overflow-hidden` 改为
    `overflow-x-clip overflow-y-visible`，其余类名与结构不变。

## 状态所有者与事件顺序

两处宿主分别拥有自己的唯一 `contextOpen`。Radix 消费受控 `open`，通过 `onOpenChange`
请求状态变更；命中桥没有状态。

```text
所有者：
  ChatContextUsage.contextOpen ── handleContextOpenChange：唯一写入入口，
      同时负责额度 access 刷新与触摸打开
  SubagentStatusFooter.contextOpen ── handleContextOpenChange：唯一写入入口
  宿主 open ──> Context (Radix HoverCard Root) ──> 面板/触发器 data-state
  Radix onOpenChange ──> 宿主的 handleContextOpenChange
  命中桥 ── 无状态，纯 CSS 命中区域

指针从圆环慢速上移（面板在 top）：
  指针进入触发器
    → trigger pointerenter → Radix handleOpen → 清 closeTimer、排 openDelay=0 → open=true
  指针跨过 2px 视觉留白
    → 指针落在触发器 ::before 命中桥（仍是 trigger 盒子）
    → 不触发 pointerleave，Radix 不会排关闭计时
  指针进入面板（命中桥与面板重叠 1px）
    → content pointerenter → Radix handleOpen → 清 closeTimer
    → 面板保持打开

指针从面板移回触发器：
  content pointerleave → Radix handleClose → 排 closeDelay=0
    → 指针落入与面板重叠的命中桥（trigger 子盒）
    → trigger pointerenter → Radix handleOpen → 清 closeTimer
    → 面板保持打开

指针横向移向邻近控件：
  离开命中桥的横向边界（= 触发器宽度）
    → trigger pointerleave → Radix 排 closeDelay=0 → 到点 → open=false

碰撞翻转到 bottom：
  ::after 命中桥覆盖触发器下方留白，事件顺序与 top 相同。

触摸设备：
  pointer-fine 媒体查询不生成命中桥
    → pointerdown 仍走 handleContextOpenChange(true) / setContextOpen(true)
    → 触摸命中区与打开语义不变。

键盘：
  focus / blur 仍由 Radix 触发器原语义驱动，命中桥不参与。
```

## 负面边界

- 不改 `Context` 的受控 `open` 语义，不改额度 access 刷新链路（`handleContextOpenChange`）。
- 不改面板宽度、圆角、阴影、内容编排与弹框存活逻辑。
- 不改 `ControlHintTooltip` 与额度面板互斥的既有逻辑。
- 不改子代理底栏行高与圆环尺寸。
- 不修改按钮 border、尺寸或其它按钮样式。
- 不改其它 `overflow-hidden` 容器，只改 composer 主调用点的紧包 span。
- 不为其它 HoverCard（`RemotePluginSyncDialog`、`ConversationStatusPanel`、
  `ConversationTurnNavigator`、附件等）批量加命中桥或改几何；它们各自的 `closeDelay`
  组合不在本次范围内。
- 不新增全局 safe polygon，也不引入新的浮层状态机。

## 验收场景

1. composer 工具栏上下文圆环（28px）：指针从圆环慢速上移到面板，面板全程保持打开，视觉留白为
   2px。
2. 子代理底栏上下文圆环（32px）：同样的慢速上移，面板保持打开，视觉留白为 2px。
3. 指针从面板移回圆环：面板保持打开，不闪烁。
4. 指针从圆环横向移动到邻近控件：面板先关闭，邻近控件仍可点击（命中桥不横向扩张）。
5. 面板因碰撞翻转到触发器下方时，慢速移动同样保持打开，下方留白为 2px。
6. 最外侧 1px 路径：从触发器左右 border box 内沿 1px 处向上穿越留白，仍保持打开；
   再向外 1px 即离开命中区。
7. 圆角附近：命中桥按 border box 矩形覆盖，圆角外沿 1px 内侧可命中，外侧不可命中。
8. 裁剪父层：紧包 span 为 `overflow-x-clip overflow-y-visible` 时命中桥可见并生效；
   临时改回 `overflow-hidden` 时命中桥被裁掉且慢速穿越会关闭（负对照）。
9. 触摸端点按圆环仍能打开面板，`pointer-fine` 不生成命中桥，命中区不被扩大。
10. 键盘 focus 打开、blur 关闭的语义不变。
11. `pnpm typecheck` 通过，改动文件 lint 干净，相关单测全过。

浏览器回归（`packages/ui/test/hoverCardTriggerGapBrowser.test.ts`）用真实隔离 Chromium 加载
实际 React `Context` / `ContextTrigger` / `ContextContent`、编译后的 Tailwind CSS 和复现
composer span 的 fixture，按上面的 1-8 条用 `page.mouse.move` 分步验证。测试只启动自己的
headless 浏览器和临时 profile，不连接或操作 YCode；找不到浏览器时显式 skip。
