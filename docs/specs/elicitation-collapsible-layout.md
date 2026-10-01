# Spec: 询问框折叠与操作区布局

## 目标

等待用户回答的询问框占据会话底部 dock。整张询问框在所有视口都可以向下收起成一条摘要行，让用户在不中断当前工作的前提下把卡片让出空间；窄屏继续沿用既有的顶部操作顺序与底部右对齐规则，让用户能直接找到收起入口，并在提交问题前快速确认主要操作集中在右侧。

## 两个不同的折叠控件

询问框上有两个容易混淆的折叠能力，必须保持独立，不能互相顶替：

| 控件           | 位置                               | 作用                                   | 可见范围                   |
| -------------- | ---------------------------------- | -------------------------------------- | -------------------------- |
| 整卡收起       | 顶部操作区最右侧 `⌄` / `⌃`         | 隐藏正文区与底部操作区，只留摘要行     | 所有视口                   |
| 长问题正文折叠 | 问题文字下方 `展开问题 / 收起问题` | 只截断超长问题正文，不动选项和底部按钮 | 仅窄屏（`max-md`，<768px） |

长问题正文折叠保持窄屏专属：桌面正文区本身就是 `overflow-y-auto` 可滚动，长问题靠滚动解决，再折一次是多余的一次点击。

## 产品规则

### 整卡收起

- 顶部操作区从左到右固定为：`倒计时（存在时）` → `上一页` → `题目进度` → `下一页` → `整张询问框收起/展开`。整卡收起/展开按钮位于最右侧；它与「只展开或收起长问题正文」的按钮是不同控件，不能混用。
- 收起后正文区（问题正文、选项、自定义回答输入）和底部操作区整体隐藏；摘要行保留 `header` Badge、问题摘要（超长截断）、倒计时、题目进度和最右侧的展开按钮。
- 点击摘要行任意位置或展开按钮都能重新展开。
- 展开态是默认状态。收起是用户主动 opt-in，询问框不得自行收起。
- 收起/展开不得改变 `questionIndex`、答案草稿、`activeOptionIndex`、倒计时和 `onRespond` 提交路径。
- 收起态下键盘方向键、`Tab`、`Enter` 不做导航也不提交：正文和底部按钮此时是 `display:none`，焦点索引推进了也落不到可聚焦元素上，焦点会掉回 `body`，用户既到不了展开按钮也提交不了。`Tab` 交给浏览器原生遍历（DOM 里摘要行在正文之后，下一个可聚焦元素正是摘要行的展开按钮）。`Escape` 例外，收起态仍要能取消。

### 窄屏操作区

- 底部操作区的「跳过/忽略」和「继续/提交」在窄屏下右对齐。键盘提示在 640px 及以下占据独立的一行，不挤占操作按钮的对齐基准；640–768px 保持单行时，父容器的 `justify-between` 已使按钮组靠右，无需提前换行。
- 宽屏保持现有的操作区语义；整卡摘要在宽屏上额外可用，但不改变顶部操作顺序和底部对齐。

## 状态所有者与不变式

- `ElicitationDialogContent` 的本地 `isDialogExpanded` 是整张询问框展开/收起的唯一状态所有者，默认 `true`。
- 长问题正文折叠由独立的 `isQuestionExpanded` 拥有，仅在 `questionIndex` 变化时重置。
- 正文区与底部操作区的隐藏必须用无条件 `hidden`（`display:none`），不能只改视觉样式：`display:none` 是「隐藏元素不可聚焦」的前提，收起态的键盘正确性依赖这一点。
- 布局与折叠不得改变问题索引、答案草稿、倒计时或 `onRespond` 提交路径。
- 收起/展开不得重置 `autoResolution`；用户仍需在紧凑摘要态看到等待状态。
- 顶部按钮顺序变化不得改变上一页、下一页、提交或取消的业务语义。
- 折叠状态是纯渲染层本地 state，不持久化、不跨快照恢复。折叠态下无法作答，因此作答导致的表单重挂载不会把用户从折叠态里踢出去。

## 事件顺序

```
点击顶部 ⌄
  └─> setIsDialogExpanded(false)
        ├─> 正文区   → hidden   （选项与输入框不可聚焦）
        ├─> 底部操作区 → hidden
        └─> 摘要行   → flex

点击摘要行 / ⌃
  └─> setIsDialogExpanded(true)
        └─> 三处原样恢复；questionIndex / drafts / activeOptionIndex 不变

收起态键盘（activeOptionIndex === -1，事件从摘要行按钮冒泡到卡片）
  ↓ ↑ Tab Enter → 直接 return，不 preventDefault
  Tab          → 走原生遍历，落到摘要行展开按钮
  Escape       → 沿用既有 goBack / dismiss
```

## 接口

- `packages/ui/src/ElicitationDialog.tsx`
  - 顶部整卡收起/展开按钮的 `className`（桌面不再 `hidden max-md:inline-flex`）。
  - 收起摘要行容器的 `className`（不再 `hidden … max-md:flex`）。
  - 正文区与底部操作区收起时的 class（`max-md:hidden` → 无条件 `hidden`）。
  - `handleCardKeyDown` 的收起态守卫及其依赖数组。
- 无协议、持久化、远程恢复或跨模块接口变化。

## 验收场景

1. 桌面宽度下，顶部操作区最右侧出现整卡收起按钮。
2. 点击收起按钮后，正文、选项和底部按钮隐藏；`header` Badge、问题摘要、倒计时、题目进度和最右侧展开按钮保留。
3. 点击摘要行或展开按钮后恢复完整询问框，当前题号、已填写草稿和 `activeOptionIndex` 保持不变。
4. 收起态按 `Tab` 不会把焦点送进隐藏的选项区，能走到摘要行的展开按钮；按 `Escape` 仍可取消请求。
5. 手机宽度下，顶部从左到右显示倒计时（存在时）、上一页、题目进度、下一页、收起按钮；收起按钮紧贴询问框右侧。
6. 手机宽度下，键盘提示位于独立行，「跳过/忽略」和「继续/提交」整体右对齐。
7. 页面刷新、切换会话或恢复远程快照后，仍由新的请求实例按默认展开态展示，不依赖本地折叠状态。

## 负面边界

- 不做折叠状态的持久化与跨快照恢复。
- 不做折叠/展开动画，保持与窄屏一致的 `display` 切换。
- 不改变 plan approval（`ExitPlanMode` 复用本组件）的可折叠性，仍与窄屏一致地可折叠。
- 不改动 `PermissionDialog` 与 `V4UserInputDialog`。
- 不改动 i18n 文案。
- 不把长问题正文折叠开放到宽屏。

## 验证

- 定向回归测试：
  - `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/elicitationDesktopCollapse.test.ts`
  - `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/elicitationMobileControlLayout.test.ts`
  - `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/elicitationSkip.test.ts packages/ui/test/elicitationDraftGuard.test.ts`
- 静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`
- 当前仓库没有真实 React 交互测试基建，也没有 E2E 基建（无 playwright/vitest 配置）。实际命中区域、收起后 dock 高度、滚动可见性和键盘落点仍需在桌面与手机宽度下人工回归。
