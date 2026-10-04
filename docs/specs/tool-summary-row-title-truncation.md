# 工具摘要行的标题截断

## 范围

本规范只管一件事：`ToolSummaryRow` 摘要行里**主文本**（`primaryText`）在宽度不够时怎么表现。

覆盖所有经 `ToolLayout` / `ToolSummaryRow` 出摘要行的渲染路径，包括时间线里脱流后的平铺行（`ConversationTurnGroup` 的 `ConversationProcessRow` 与 `ConversationPlanCallRecordRow`）。

不覆盖带边框外壳的独立卡片（如计划卡 `switch-mode` 的折叠卡、TaskOutput 卡）：那些盒子有自己的多行布局与 `line-clamp-*` 策略，不受本规范约束。

## 产品规则

- **摘要行恒为一行。** 主文本超出可用宽度时收成省略号，不折行、不撑宽行、不把行底的分隔线顶下去。摘要行下面往往紧跟分隔线或下一块内容，折行会让整段流程错位。
- **截断由调用方自己做，共享层不代劳。** `primaryText` 是 `ReactNode`，可能是一段纯文本，也可能是多段结构（`execute` 的命令块、`todo` 的进度节点），各渲染器对「哪一段该先被压缩」的判断不同。共享层一刀切 `truncate` 会裁掉本该可交互或可展开的内容。
- **纯文本主文本统一包 `<span className="min-w-0 truncate">`。** `min-w-0` 不能省：它是 flex 子项，`min-width: auto` 会让它撑在内容宽度上压不下去。`truncate` 自带 `overflow: hidden`，因此 flex 自动最小尺寸随之塌成 0，这一格能被压到内容宽度以下并由自己的盒子裁出省略号。
- **类别标签与图标不参与压缩。** 它们是 `shrink-0` + `whitespace-nowrap`，窄屏下先牺牲的是主文本，不是类别词。`prioritizePrimaryText` 另有窄屏隐藏类别标签的语义（edit/read/execute 在用），与本规则无关，不要顺手启用。
- **被截掉的全文必须仍然可达。** 截断是视觉裁剪，DOM 文本不变，屏幕阅读器照常读到全文；但鼠标用户只能靠悬停，所以主文本被截断时要把全文交给 `ToolLayout` 的 `title`，由它落到行容器的 `title` 属性。

## 所有权与接口

- 渲染器通过 `ToolLayout` 的 `primaryText` 传入自己的截断节点，通过 `title` 传入全文。两者都是既有 prop，本次不新增接口。
- `ToolSummaryRow` / `QueuedSummaryContent` 共享层不改。`tool-summary-content` 只是测试用的标记类，全仓库没有对应 CSS 规则，不会兜住任何截断。
- `ToolLayout` 是 `memo` 的。包截断的节点必须 `useMemo`，每次渲染现造元素会让浅比较永远不成立。

## 负面边界

- 不给共享层加全局 `truncate`，理由见上。
- 不改完整计划卡 `switch-mode` 的 `line-clamp-2`，那是独立卡片的既定形态。
- 不改 `ConversationShareReadonlyTimeline` 的只读路径：它经 `ToolCallPresentation` 出完整卡片，不走平铺摘要行。
- 已知未按本规范排查的调用点不在本次范围内，发现时按同一规则单独修，不要顺手改共享层。

## 验收场景

- 一条工具摘要行的主标题长到超出一行：行高不变，标题尾部出现省略号，下方分隔线位置与其它工具行一致。
- 同一条行标题较短时：显示与截断前完全一致，不出现多余省略号。
- 鼠标悬停该行：出现完整标题的系统提示。
- 窗口收窄到约 360px：图标与类别标签保持完整不被压缩，主文本省略号收尾，全程不折行。
- 回归用例：`packages/ui/test/planCallRecordRowRender.test.ts` 覆盖计划平铺行的显式标题、正文首行回退、`title` 透出与短标题四条路径。
