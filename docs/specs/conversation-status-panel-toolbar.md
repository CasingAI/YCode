# Spec: 状态面板展开态右上角工具胶囊

## 目标

会话状态面板展开后，右上角那组「显示模式菜单（`…`）」和「收起为胶囊（`Minimize2Icon`）」按钮是面板上唯一的常驻操作入口，却一直是两个各自独立的 ghost 按钮：容器只有定位和 `gap-1`，没有底座，两个按钮于是读作两个浮在面板上的裸图标，而不是一个控件。

本次把这组按钮包进一个带背景和边框的小胶囊，让它在视觉上成为一块可识别的操作区；同时补上分区标题行右侧本来就该有、却一直不够宽的预留通道。

```
┌─ 状态面板 ─────────────────────┐
│  Git 工具            ╭───╮     │
│                      │ ⋯ ⤡ │     │   ← 58 × 30 胶囊
│  更改          +7920 -932      │
```

## 产品规则

- **胶囊是工具条，不是卡片。** 它绝对定位在面板壳内部、滚动容器之外，因此面板内容滚动时会从它底下穿过。加了背景之后它就从「两个透明图标」变成「压在滚动内容上的浮层」，所以底色必须不透明，不能用半透明叠色。
- **底色用 `--color-menu`，边框用 `--color-popover-border`。** 面板壳本身是 `bg-popover border-popover-border`，两者的关系是：`styles.css` 里浅色主题下 `--color-menu` 与 `--color-popover` 同为白，所以浅色下胶囊靠边框立形；深色下 menu 是 `neutral-950`、popover 是 `neutral-800`，胶囊比壳深一档，正好读作浮在上面的浮层。这符合 `DESIGN.md`「Prefer `bg-popover` 或 `bg-menu` for overlays; pair with `border-popover-border` 或 `border-border`」，也符合本 spec 的产品气质（calm / dense / operational，不做装饰）。
- **胶囊内的按钮保持 `variant="ghost"`。** 它们的 hover 走 `--color-hover`，在浅色（neutral-200 底在白底上）和深色（white 10% 底在 neutral-950 上）下都能与 `--color-menu` 拉开对比；打开态由 `aria-expanded:bg-hover` 接管，同样可见。
- **容器与两个按钮同为整圆，组成一个完整的胶囊形状。** 容器用 `rounded-full`；两个 24×24 按钮也用 `rounded-full`，圆到胶囊外沿留 `1(border) + 2(padding)` = 3px。这里**不套** `DESIGN.md` Basic controls 表的「控件按最近圆角父容器向下走一级」——那张表描述的是普通容器向下一级（xl→lg→md→sm），而刻意胶囊的对偶形状就是圆。`DESIGN.md`「`rounded-full` is reserved exclusively for deliberate pill shapes」在这里成立：按钮用整圆是因为**处在一个刻意胶囊里**，而不是「因为它是 icon 按钮」——后者恰恰是那条限制针对的情形。按钮若保持 base 的 `rounded-md`，整组会读作「药丸套方块」，是本胶囊形态的反面。
- **内边距 `p-0.5`。** `Button` base 自带 `border border-transparent`，不加内边距胶囊边框会直接贴到图标上。
- **不加阴影。** `DESIGN.md` 的 Surface 层是「very subtle border-led separation」，边框加背景已经够了；面板壳自己带 `shadow-md`，再叠一层属于用阴影堆层级。

### 布局不变量：分区标题行必须让出胶囊宽度

这条是本次改动真正的前置条件，也是此前一直存在的欠账。

胶囊容器绝对定位在 `<aside>` 内、滚动容器**之外**，所以它下面会经过内容里的**每一行**分区标题，不只是第一行。`StatusSectionHeader` 的右侧预留必须按胶囊的完整宽度算：

```
面板壳 w-80                                     = 320
内容 p-2                        → 可用区 [8, 312]
胶囊 right-3 右边缘 = 320 - 12                    = 308
胶囊宽 58（两个 size-6 按钮 + gap-1 + p-0.5×2 + border×2）
                          → 胶囊左边缘           = 250
标题内容右边缘 = 320 - 8 - pr ≤ 250 - 6          → pr ≥ 68px
```

改动前的 `pr-8`（32px）推出来标题内容右边缘在 280，比胶囊左边缘还往右 24px。这 24px 的重叠一直没人看见，**正是因为按钮是透明的**——文字滑到它下面也看不出被盖住。胶囊一旦有了不透明底色，重叠立刻变成实打实的「文字被压住」。

因此胶囊宽度与标题行预留是**一对必须联动的数字**：改胶囊的按钮尺寸或内边距，必须同步改 `pr`。两处都通过文件顶部的常量 + 注释绑定在一起，不允许只改一边。

### 这条通道在什么时候存在

- **`mini` 变体**：`variant === "mini"` 时整个分区容器根本不渲染（`{variant !== "mini" ? … : null}`），`StatusSectionHeader` 不会出现在 DOM 里，预留自然不存在。
- **`auto` 变体窄视口**：工具条被 `hidden @min-[1280px]/conversation:flex` 隐藏，预留会空着。这与改动前空着的 32px 是同一笔账，不为它做断点联动的写法——那需要把 `variant` 穿过 7 个 section 组件，代价与收益不匹配。

## 接口

- 渲染接线：`packages/ui/src/v4/ConversationStatusPanel.tsx`
  - 文件顶部新增常量 `STATUS_PANEL_TOOLBAR_CLASS`（工具条容器的完整 className，含 `absolute right-3 top-3 z-10 items-center gap-1 rounded-full border border-[var(--color-popover-border)] bg-[var(--color-menu)] p-0.5`）与 `STATUS_PANEL_TOOLBAR_RESERVED_WIDTH`（`pr-17`），注释写清两者的推导关系。
  - `ConversationStatusPanelImpl` 里工具条容器的 `className` 改用 `cn(STATUS_PANEL_TOOLBAR_CLASS, variant === "auto" ? … : "flex")`。
  - `StatusSectionHeader` 的 `pr-8` 改为 `STATUS_PANEL_TOOLBAR_RESERVED_WIDTH`。
  - 两个按钮的 `className` 各自从 `"size-6"` 改为 `"size-6 rounded-full"`。`cn()` 走 `extendTailwindMerge`，cva 把 `className` 拼在 base 之后，`rounded-full` 覆盖 base 的 `rounded-md`；`DropdownMenuTrigger asChild` 与 `ControlHintTooltip` 的 Slot 层只拼接 `shrink-0`，不带 radius，不冲突。按钮变圆**不改变外框尺寸**，所以上一条的 `pr-17` 推导继续成立。
- 保留不动：两个按钮的尺寸（`size-6`）、图标、`variant="ghost"`、`DropdownMenu` 结构与 `align`/`side`、`ControlHintTooltip` 包裹、i18n 文案 key、点击行为。
- 保留不动：`packages/ui/src/components/ui/button.tsx`。胶囊是这一个容器的局部形态，不新增 `Button` 变体。
- 无新增 i18n、无协议字段、无状态。

## 负面边界

- **设置页里同形的 `absolute right-3 top-3 flex items-center gap-1` 按钮组不碰。** `AutomationsSection.tsx`、`OffPeakTaskList.tsx`、`SavedWorkflowCard.tsx` 各有一处形状相同的容器，但它们的父卡片底色不同（`bg-background` / 行内卡片），胶囊的 `bg-menu` 取值不能照抄过去。本次只改状态面板这一处。
- **不给胶囊补 `focus-visible` 描边。** 这两个 ghost 按钮现在就没有 focus ring（同文件的 `GoalStatusSection` 暂停按钮、全仓 ghost 按钮都一样），这是既有的可访问性缺口，不是本次改动造成的；顺手补会把纯视觉改动混进行为变更。要补应单独一轮，且覆盖面板内所有 icon 按钮。
- **不改分区标题行右侧 trailing 内容的构成。** 进度 / 计数 / 时长各支维持现状，本次只调预留宽度。
- **不重构 `StatusSectionHeader` 的 prop 链路。** 见上「这条通道在什么时候存在」。

## 验收场景

1. 打开一条有 Git 改动的会话，展开状态面板：右上角两个图标按钮落在一个带背景和边框的小胶囊里，**胶囊与两个按钮都是整圆**，形状读作「一个胶囊里两个圆点」，圆到胶囊外沿留约 3px 白边不贴边；胶囊不与「Git 工具」标题行重叠。
2. 悬停任一按钮：高亮是一个圆而不是圆角方块；打开显示模式菜单时第一个按钮的高亮同样是圆。
3. 同一会话把 Todo 列表滚到中部：滚过的每一行分区标题的尾部文案（进度 / 计数 / 时长）都没有被胶囊盖住。
4. 切深色主题重复场景 1、2：胶囊底色比面板壳明显深一档，按钮 hover 时有可见反馈。
5. 点胶囊右侧的收起按钮回到 `mini`：胶囊整体消失，回到单行摘要胶囊，预留宽度不产生可见空白。
6. `auto` 变体在 <1280px 的会话容器宽度下：工具条不渲染，分区标题行右侧留白与改动前同量级，不出现半截边框。
7. 英文界面下胶囊形态与位置不变（无文案，不受 i18n 影响）。
8. `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 通过。

## 未覆盖 / 已知取舍

- 仓库没有 React 渲染测试基建，胶囊的 DOM 形态与几何靠 `packages/ui/test/conversationLayout.test.ts` 邻近的纯函数测试与人工验收覆盖。几何是两条绑定死的推导（胶囊宽 58 ↔ 预留 68），常量与注释是它唯一的护栏。
- 浅色主题下 `--color-menu` 与 `--color-popover` 同色，胶囊在浅色下只靠边框立形。这是有意取舍：底色与面板壳同族是 `DESIGN.md` 对浮层的规定，用一个更重的填充（例如 `--color-hover`）会让这块操作区在安静的操作型面板里过分突出。
