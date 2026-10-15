# 消息编辑卡思考控件钉死档位竖条形态

> 状态：已实现。适用面：`packages/ui` 的 v4 消息编辑卡（`ConversationRowView` 编辑态）与共享控件 `ThoughtLevelCycleControl`。

## 1. 产品规则

思考强度控件 `ThoughtLevelCycleControl` 原本只随容器宽度（`@sm/composer`–`@xl/composer` 容器断点）自适应：

- 窄（<@sm）：灯塔图标；
- 中（@sm–@xl）：灯塔图标 + 绿色档位竖条（`w-1` 圆角轨道 + `bg-success` 自底向上填充，高度 = 思考档位序号占比，无文字无箭头）；
- 宽（≥@xl）：灯塔图标 + 档位文字 + 下拉箭头。

消息编辑卡的容器宽度普遍落在 ≥@xl，因此用户看到的是「灯塔 + 文字 + 箭头」，用户明确不要这种形态，要求编辑卡**任何宽度都钉死中等宽度那套「灯塔 + 绿色档位竖条」**（无文字、无箭头、无键帽）。

- 竖条即档位表达：轨道自底向上填充，高度 = `非关闭档位序号 / 非关闭档位总数`，与既有进度条逻辑同源，不另造算法。
- 点击竖条形态仍打开原 Radix Select 档位菜单；`Ctrl+T` 循环快捷键、`aria-label`（档位词）不变。
- hover 提示沿用工具条默认行为：标题显示当前档位词（该形态下无内联文字，`inlineLabelVisible` 恒按 false 处理），快捷键键帽照常。
- 范围仅限编辑卡。主输入框维持自适应梯子（宽=文字+箭头、窄自然变成竖条），设置页（WorkflowRunSettings / SubagentReasoning / OffPeak / Automation）维持边框胶囊「灯塔+文字+箭头」，均零改动。

## 2. 所有权与契约

- 形态决策的唯一所有者：`ThoughtLevelCycleControl` 的新 prop `variant`（`"toolbar" | "levelBar"`，默认 `"toolbar"`），类型 `ThoughtTriggerVariant` 定义在叶子模块 `chat-input-toolbar/thoughtLevelOptions.ts`。
- `V4ComposerModelControls` 只透传（新 prop `thoughtVariant`），不自行拼装竖条样式；编辑卡调用点（`ConversationRowView`）只声明 `thoughtVariant="levelBar"`。
- levelBar 形态下下拉箭头必须显式传隐藏占位元素移除：`SelectTrigger` 的 `indicator ?? 默认箭头` 对 `null`/`undefined` 不生效。
- 提示标题取舍收敛为纯函数 `resolveThoughtTooltipTitle`（同叶子模块）：`disabledReason` 优先；`levelBar` 恒返回当前档位词；`toolbar` 维持「文字可见→控件用途文案，不可见→档位词」的原逻辑。
- 复用方在 levelBar 下不传 `@max-sm/composer:size-7` 等窄宽压缩类，避免灯塔+竖条被压进 28px 方块。

## 3. 验收场景

1. 编辑已发送消息：思考控件显示为「灯塔 + 绿色档位竖条」，无文字、无箭头；点击弹档位菜单，选择后竖条高度即时更新。
2. 编辑卡拉宽到 `max-w-xl`：形态不变，仍是竖条，不回退成「文字+箭头」。
3. 主输入框：自适应行为与改前完全一致（宽=文字+箭头，中=竖条，窄=灯塔）。
4. 设置页各推理强度字段：边框胶囊「灯塔+文字+箭头」不变。
5. 单档模型（无可切换档位）：编辑卡内同样渲染竖条形态。
6. `Ctrl+T` 循环：编辑卡与主输入框的竖条高度同步滚动。
7. hover 竖条：提示显示当前档位词与快捷键键帽。
