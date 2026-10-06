# 时间线 marker 分隔线水平边距

## 目标

时间线上的 marker 分隔线（`MarkerDividerRow`：compact / forkNotice / goalVerify / modelChange
四种共用同一外壳）在窄屏下会把本可单行显示的文案挤成两行，例如
「第 2 次迭代 · 目标未完成，任务继续」只差一个字却掉了下去。本 spec 拿掉外壳上多余的
水平内边距，把宽度还给中间文案。

## 产品规则

- **水平边距只有轮 `<section>` 一处所有者**。轮容器（`ConversationTurnGroup`）已有
  `px-4 @md/conversation:px-6`，负责与屏幕边缘的留白。分隔线行直接挂在轮容器下，
  中间没有再包一层需要对齐正文的容器，因此自己不再加 `px-4`。
- **分隔线顶满轮容器给它的宽度**。`MarkerDividerRow` 的行类只保留 `py-2` 纵向节奏，
  去掉 `px-4`；左右横线（`h-px min-w-8 flex-1`）与中间文案的 `gap-3`、横线自身的
  `min-w-8` 保底都不动——本次只收重复边距，不动弹性结构。
- **四种 marker 同进退**。外壳是四种共用的，改一次即四条分隔线一起受益，不按
  `marker.type` 分支。
- **中文不断词**：中文没有空格，浏览器可在任意两字之间断行。窄屏下只差一个字时，
  拿掉的 32px（左右各 16px）足以让尾字回到第一行；真正超长的文案仍按 `break-words`
  正常换行，不强制单行。

## 接口

- `packages/ui/src/v4/ConversationRowView.tsx`：`MarkerDividerRow` 的 `rowClassName`
  从 `flex w-full items-center gap-3 px-4 py-2 …` 改为
  `flex w-full items-center gap-3 py-2 …`（可点变体只追加 hover 文色，不动边距）。
- 只读分享时间线（`ConversationShareReadonlyTimeline`）与分享导入提示
  （`ConversationShareImportNotice`）各有自己的布局契约，本次不动。

## 负面边界

- 不改横线显隐与弹性（`flex-1` / `min-w-8`）、不改 `gap-3`、不加 `nowrap` / `truncate`。
  文案超长时允许换行居中，不为了单行去裁内容。
- 不改 `py-2` 纵向节奏，不改轮容器的 `px-4 @md/conversation:px-6`。
- `[model-change-divider-thought-level.md](./model-change-divider-thought-level.md)` 的
  「不改外壳类名」一条让位给本 spec：当时是为了避免误伤四条线，本次正是四条一起改，
  属于已评审的例外。

## 验收

1. 341px 宽视口下「第 2 次迭代 · 目标未完成，任务继续」单行显示，两侧横线仍可见。
2. 真正超长的分隔线文案（如带长模型名的切换线）仍换行居中，容器不溢出。
3. compact / forkNotice / modelChange 三条线的左右对齐与改前一致，只是整体变宽。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
