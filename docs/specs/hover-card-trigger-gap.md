# Spec: HoverCard 触发器与浮层之间不留命中空档

## 目标

composer 工具栏的上下文用量圆环、子代理底栏的上下文圆环都用 Radix HoverCard 展示额度面板。
用户把指针从圆环慢速移到面板上时，面板会先消失：指针还没碰到面板，浮层就没了。

根因是 Radix HoverCard（`@radix-ui/react-hover-card` 1.1.x）在触发器 `pointerleave` 时直接
`onClose()`，并且没有 Popover 那样的安全多边形（safe polygon）。触发器与面板之间只要留出
一段命中空档，指针无论多慢都要穿过这段空档，浮层必然在指针到达面板之前被关闭。移动快的时候
一次命中测试就直接跨过空档，所以只有慢速移动才复现。

本改动把面板下沿压到触发图标的上沿：既去掉视觉上的空档，也让触发器与面板的命中区连续，
浮层是否关闭不再取决于指针移动速度。

## 产品规则

- **面板下沿必须贴住触发图标的上沿**：触发器与面板之间不得存在「既不属于触发器、也不属于面板」
  的命中空档。判定标准是面板下沿落在触发器盒子的范围内（偏移 ≤ 0），而不是靠延时兜底。
- **偏移只压掉触发器盒子的透明内边距**：触发图标固定 14px（`size-3.5`），面板偏移取
  `-(触发器高度 - 图标高度) / 2`，即触发器盒子上半部的内边距。图标本体不被面板遮挡，
  图标仍然完整可见、可点击。
- **偏移由共享计算得出**：`resolveContextPanelSideOffset(triggerHeightPx)` 是唯一出处，
  调用方只声明自己的触发器高度，不各自手写负数，避免两处浮层的几何关系各自漂移。
- **不用 closeDelay 兜底**：仓库里其它 HoverCard（`RemotePluginSyncDialog`、
  `ConversationStatusPanel`、`ConversationTurnNavigator`）用 `closeDelay` 是因为它们的几何上
  必然留有空档。上下文用量浮层把空档消除后，`closeDelay` 不再承担命中修补的职责，
  不得用它掩盖几何缺陷。
- **触摸端语义不变**：触摸设备的打开仍由 `ContextTrigger` 的 `pointerdown` 处理，
  面板几何调整不改变这一点。

## 接口

- `packages/ui/src/components/ai-elements/context.tsx`
  - 新增导出 `resolveContextPanelSideOffset(triggerHeightPx: number): number`，
    返回让面板下沿贴住图标上沿的负偏移。
  - 触发图标尺寸 14px 为模块内常量，不重复散落到调用方。
- `packages/ui/src/chat-input-toolbar/contextUsage.tsx`
  - `ContextContent` 的 `sideOffset` 由 `2` 改为 `resolveContextPanelSideOffset(28)`
    （触发器是 `Button size-7`，28px）。
- `packages/ui/src/v4/SubagentStatusFooter.tsx`
  - `ContextContent` 的 `sideOffset` 由 `2` 改为 `resolveContextPanelSideOffset(32)`
    （触发器是 `h-8 w-8`，32px）。

## 状态与时序

打开与关闭仍由 Radix HoverCard 拥有（`Context` 的受控 `open` / `onOpenChange` 不变），
本次只改几何：

```text
指针进入圆环
  → 触发器 pointerenter → handleOpen() → 面板打开（受控 open=true）
指针上移，跨过圆环上沿（= 面板下沿）
  → 同一轮命中测试内：触发器 pointerleave → handleClose() 排入关闭计时
                       面板 pointerenter  → handleOpen() 清掉该计时
  → 面板保持打开
指针移出触发器与面板之外
  → handleClose() → 关闭计时到点 → 面板关闭
```

修复前的偏差：面板下沿在触发器盒子上沿之上 2px（`sideOffset={2}`），这段空档两边都不属于
触发器和面板。指针落进空档时只触发 `pointerleave`，而 `closeDelay=0` 让关闭在下一轮宏任务
就生效，面板在指针到达之前就被卸载。

## 负面边界

- 不改 `Context` 的受控 `open` 语义，不改额度 access 刷新链路（`handleContextOpenChange`）。
- 不改面板宽度、圆角、阴影与内容编排。
- 不改 `ControlHintTooltip` 的 reset 状态提示与额度面板互斥的既有逻辑。
- 不改子代理底栏行高（`h-8`）与圆环尺寸，只改浮层相对触发器的偏移。
- 不为其它 HoverCard 批量改几何；它们各自的空档与 `closeDelay` 组合不在本次范围内。

## 验收场景

1. composer 工具栏上下文圆环：指针从圆环慢速上移到「Codex 额度」面板，面板全程保持打开，
   面板下沿与圆环之间没有可见空档。
2. 子代理底栏上下文圆环：同样的慢速上移，面板保持打开。
3. 指针从面板移回圆环、再移出到页面空白处，面板按原有语义关闭。
4. 触摸端点按圆环仍能打开面板（打开规则见
   [`subagent-status-footer.md`](./subagent-status-footer.md) 与
   `packages/ui/src/chat-input-toolbar/contextUsage.tsx` 的 `onPointerDown`）。
5. `pnpm typecheck` 通过，改动文件 lint 干净，相关单测全过。
