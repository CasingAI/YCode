# Spec: Todo 胶囊右侧圆形进度环

## 目标

输入框上方那枚会话状态胶囊在**有进行中 Todo 项**时只显示一个 `→` 箭头和当前项文本（超长截断成 `…`），用户看不出整份 Todo 走到了哪里。本次给这枚胶囊的文本右侧加一枚 16px 圆形进度环，弧长读作「已完成 / 总数」，让截断文本不必展开面板就能报出整体进度。

```
→ 补偿合成仿真对账P3/P4（真增量=差值+in…  ◔
```

进度数据不是新增的：`conversationStatusPanelModel.ts` 的 `buildPlanModel` 已经产出 `completedCount / totalCount`，只是收起态胶囊分支只用了 `currentPlanItem.content`，把计数留在了展开态面板里。本次把同一个事实接进收起态，**不动数据模型、不加协议字段**。

## 产品规则

- **进度公式**：`percent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0`。整数与浮点都直接透传给组件，组件内部 clamp 到 `[0, 100]`（`progress.tsx` 的横向 `Progress` 是同一口径）。
- **只在「有进行中 Todo 项」这一分支显示**：条件是 `getCurrentPlanItem(model.plan)` 非空，即存在 `inProgress` 项，或没有任何 `inProgress` 但仍有 `pending` 项。其余分支一律不出圆环：
  - 活动 goal、Git 改动、已完成 goal、最近完成的 plan 项、「有 plan 但无当前项」的计数形态（`进程 3/5`）、会话计划、后台任务计数、已结束 workflow 计数 —— 这些分支各自的主语义不是「正在推进的 Todo」，加圆环等于给它们安一个不属于它们的进度来源。
  - 尤其「进程 3/5」那一支**不显示**圆环：它已经用数字把进度写在文本旁边了，再加一枚同义的圆环是同一事实的两处写法。**该支已在同一次改动中删除**（见「负面边界」里对它的可达性证明）。
- **形状与语义色**：16px 圆环（`size-4`，与同排的 `size-4` 图标同基线），描边 1.5px。轨道用 `--color-border`，进度弧用 `--color-foreground`（中性，跟随主题和「进程」的安静语义）。**不借用** `--color-success` / `--color-warning` / `--color-destructive`——这三色在本组件语义里分别属于「已完成项」「运行中」「失败」，把完成比例画成 success 会让一条待办看起来已结算。
- **不做旋转动画**：左侧是静态 `ArrowRightIcon`（`todo.tsx` 明确选了静态箭头以免与加载动画混淆），右边再叠一个转圈会把「Todo 在推进」读成「有东西在加载」。圆环只随 `percent` 变化重绘，不加 `animate-*`。
- **常驻，不参与 hover 让位**：胶囊悬停时左侧图标槽被 `Maximize2Icon` 替换（`group-hover:opacity-0`），圆环在自己的节点上，不吃这套替换，所以悬停时进度不消失。
- **不被文本压扁**：文本槽是 `min-w-0 truncate`，圆环必须 `shrink-0`，否则超长 Todo 名（截图那种）会把圆环挤成一条竖线。
- 遵守 `DESIGN.md`：文字层级继续用既有 `text-ui-base`（本次不加新文案尺寸），`rounded-full` 用于刻意圆形属合规（DESIGN Radius 章节明文允许 pills/circles）。
- 无障碍：圆环是 `role="img"` + `aria-label`（走 i18n，含 `completed/total` 与百分比），**不是** `role="progressbar"`：它是胶囊里的一枚静态图示，胶囊整体是按钮并已有自己的 `aria-label`，给内部图示挂 `progressbar` 会让读屏在按钮里再报一个可交互控件。title 同样走 i18n。

## 接口

- 新增组件：`packages/ui/src/components/ui/circular-progress.tsx`
  - `export function CircularProgress({ className, label, size, value }: { className?: string; label: string; size?: number; value: number })`
  - SVG 双圆：`viewBox="0 0 16 16"`、轨道 `r=6.75`、进度弧 `stroke-dasharray` 按 `percent` 计算（`2πr ≈ 42.41`），`stroke-linecap="round"`，`transform: rotate(-90deg)` 让 0% 从 12 点方向起画。
  - `size` 缺省 16；调用方不传额外尺寸时不用改 class。
- 渲染接线：`packages/ui/src/v4/ConversationStatusPanel.tsx`
  - `StatusSummaryMetric` 新增可选 `trailing?: ReactNode`，排在 `{children}` 之后（缺省即现状，git 那一支的 `+n` / `-n` 是手写 children，不受影响）。
  - `StatusSummaryRow` 的 `currentPlanItem` 分支改传 `trailing={<CircularProgress … />}`，并在 `model.plan` 缺席时返回 `null`（此时 `currentPlanItem` 必为 null，这条分支实际不可达，写明只是为了不让 `percent` 的除数变成潜在 NaN）。
- i18n：`packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` 新增 `chat.statusPanel.todoPillProgress`（例：zh「已完成 {completed} / {total}（{percent}%）」，en "Completed {completed} / {total} ({percent}%)")。
- 保留不动：`conversationStatusPanelModel.ts` 的数据形状、`ToolCallBlocks/renderers/todo.tsx`、`WorkflowAgentPill` / `WorkflowArtifactPill` 的尾槽语法、`RosterMeter`、胶囊其余全部分支、展开态面板。

## 状态与时序

```
PlanState (snapshot)
   └─▶ buildPlanModel() → { completedCount, totalCount, items }   ← 唯一事实来源，无改动
          │
          ├─▶ StatusSummaryRow: currentPlanItem ? … : …            ← 加 CircularProgress(trailing)
          └─▶ TodoSection(展开态面板)                              ← 不变
```

- 进度无本地状态：每帧由 `completedCount / totalCount` 直接算出，不缓存、不回写。
- `completedCount` 由 `buildPlanModel` 按 `status === "completed"` 计数，与展开态面板同源，所以胶囊和面板永远不会显示两个不同的进度。

## 展开态面板的「进程」计数：`n/m` → `xx% 剩 x 个`

收起态胶囊有圆环之后，展开态面板那一行右侧的 `{completedCount}/{totalCount}` 仍是一个需要心算的分数。面板有整份列表可看，**空间不紧张**，所以那里改成人和机器都不用换算的直读形式：

```
进程  14% 剩 6 个        ← 1/7
进程  已完成              ← 7/7（全部完成）
```

- **未完成**：`{percent}% 剩 {remaining} 个`。`percent` 取 `Math.round(completedCount / totalCount * 100)`；`remaining = totalCount - completedCount`。
- **全部完成**（`completedCount >= totalCount`）：只写「已完成」，不再报数字。此时「剩 0 个」是废话，而全部完成是一个值得单独说的事实——它同时换 `--color-success` 绿（既有行为保留）。
- **百分比取整到整数**：面板宽度按 `text-ui-base` 排版，`.5%` 这类精度没有信息量，且 `tabular-nums` 下多一位小数会让这行的宽度抖动。
- **排序**：`%` 在前、「剩 x 个」在后。先报完成度再报剩余，与列表从上到下的阅读顺序一致（已完成折叠组在前、当前项与待处理在后）。
- **不变的东西**：面板这一行仍带 `tabular-nums`（数字对齐）、完成态仍用 `--color-success`、未完成仍用 `--color-foreground-subtle`。折叠组（`已完成 n 项` / `待处理 n 项`）与列表项形态一律不动。
- **与收起态的关系**：胶囊走圆环（弧长 = 完成比例），面板走「百分比 + 剩余个数」（两个数字）。两处读的是同一个 `completedCount / totalCount`，形状不同是因为可用空间不同，不合并。

### 顺带删除：胶囊里不可达的「进程 n/m」

`StatusSummaryRow` 曾有一支渲染 `进程 {completed}/{total}` 的胶囊分支。本次删除，理由是它**不可达**，已穷举证明：

- 该支的渲染条件是 `currentPlanItem === null` **且** `completedPlanItem === null` **且** `model.plan !== null`。
- `currentPlanItem` 为空要求全部项都不是 `inProgress` 也不是 `pending`；`completedPlanItem` 为空要求没有 `completed`。两者同时成立 = 没有任何一项带这三态中的一种。
- 而 `planItemSchema`（`packages/shared/src/zcode-protocol-v4/snapshot.ts`）的 `status` 枚举只有 `pending | inProgress | completed`，且 `buildPlanModel` 在 `items.length === 0` 时返回 `null`。所以 `model.plan !== null` 时必然至少有一项带这三态之一，矛盾。
- 对 n = 1..5 穷举全部 `3^n` 种 status 组合（合计 363 种）逐一验证，命中该支的组合数为 **0**。

删除后胶囊行为逐像素不变（该支渲染不出来），收益是「胶囊里没有计数」在代码层面也是真的——留着它会让人以为胶囊真会显示 `3/5`。

## 验收场景

1. 有进行中 Todo（如 `补偿合成仿真对账P3/P4`），已完成 1 项共 4 项 → 胶囊文本右侧出现圆环，进度弧占 25%，轨道完整可见；`aria-label` 读出「已完成 1 / 4（25%）」。
2. Todo 文本超长被截断成 `…` 时 → 圆环保持 16px 完整圆，不被压扁或裁切；文本省略号仍在圆环左侧。
3. 悬停胶囊 → 左侧箭头换 Maximize2Icon，圆环仍在原位不变色、不消失。
4. 全部 Todo 完成（无 `inProgress` 与 `pending`）→ 胶囊退回「最近完成项 + 绿色对勾」形态，不出现圆环。
5. 展开态面板，计划 7 项完成 1 项 → 「进程」右侧显示 `14% 剩 6 个`，不再是 `1/7`。
6. 展开态面板，7 项全部完成 → 右侧显示 `已完成`，用 `--color-success` 绿，不出现数字。
7. 无 plan（活动 goal / Git 改动 / 后台任务计数 / 已结束 workflow）→ 胶囊形态与改动前逐像素一致。
8. 收起态胶囊在 1–5 项各种 plan 组合下均不渲染计数（该支已删除，无回归）。
9. 浅色 / 深色 / Zai 三套主题下轨道与进度弧对比正常。
10. 中英文界面下 `aria-label`、title 与「进程」计数文案都跟随语言切换。
11. 点击胶囊仍切到 `panel` 变体，键盘聚焦环不变。

## 验证

- `pnpm typecheck`、`pnpm lint`。
- 单测：`TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/conversationTodoPillProgress.test.ts`
  - 覆盖进度纯函数：0 项不产生 NaN、全部完成为 100、单项为 100（单待办列表首次渲染就是完成态）、部分完成比例、`inProgress` 优先于 `pending` 的当前项选择。
  - 覆盖 `planProgressLabel` 的三态：未完成取整百分比 + 剩余个数、全完成返回 null（渲染层据 null 走「已完成」）、0/0 返回 0。
  - 覆盖胶囊计数分支删除后的可达性：对 n = 1..5 穷举 `3^n` 种 status 组合，断言 `StatusSummaryRow` 的优先级链在 `plan` 非空时总能落到 `currentPlanItem` 或 `completedPlanItem` 之一（穷举证明等价于「该支已删除」）。

## 未覆盖 / 已知取舍

- 仓库没有 React 渲染测试基建，`CircularProgress` 的 DOM 形态与 `StatusSummaryMetric` 的接入点靠 `conversationStatusPanelModel.test.ts` 邻近的纯函数测试与人工验收覆盖；圆弧几何本身（`stroke-dasharray` 数值）抽成导出常量以便断言。
- 圆环不随面板展开后的分区样式变化，展开态仍用既有的 `RosterMeter` / 计数行表达进度——两处形状不同但同源，这是既有设计（收起态信息密度优先），本次不合并。
- 该胶囊在 `@min-[1280px]/conversation` 以下显示，桌面宽屏走面板形态，因此宽屏用户看不到圆环；这是既有响应式规则，不在本次范围。
