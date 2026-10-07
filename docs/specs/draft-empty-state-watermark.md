# 草稿空态（无问候语）

## 当前规则

- 新建页（会话草稿态）不渲染问候语，不渲染文字水印、背景字样或旧 Z logo。
- 空态槽位直接为 `null`：时间线只保留底部输入 Dock 的居中布局，不再挂载任何装饰节点。
- 草稿空态与底部输入区的现有间距保持不变；移除问候语不得改变时间线、底部 Dock 或输入框的布局协议。
- `chat.empty.greeting.*` 中英文文案已删除，不再保留；后续不得以“恢复问候语”为由重新引入。

## 实现位置

- `packages/ui/src/v4/SessionPane.tsx`：`isDraft` 时 `emptyState` 传 `null`，保留 `centerEmptyStateWithDock` 以维持 Dock 居中。
- `packages/ui/src/i18n/locales/zh-CN.ts`、`en-US.ts`：已删除 `chat.empty.greeting.*`（含 office 条目）。

## 历史说明

- 2026-09 之前草稿空态使用 ZCode 的 Z logo（浅色内联描边 SVG + 深色 `assets/Z.svg` 位图）；改为文字水印后，`assets/Z.svg` 已删除。
- 2026-09-23 水印改为大号「新建」文字，并通过纵向 mask 尝试渐隐。该文字盒相对只有单行问候语高度的父容器绝对居中，必然覆盖问候语中心；移除 mask 后仍可稳定观察到问候语横穿水印中部。
- 2026-09-25 用户选择直接移除水印，而不是继续依赖字号、魔法偏移、遮罩或额外覆盖层规避重叠。
- 2026-10-05 新建页问候语在桌面端偶发只剩半透明残影（macOS vibrancy 合成 surface 失效，见 `docs/specs/desktop-window-compositing-repaint.md`）。该问题偶发且修复效果待真机观察。
- 2026-10-07 用户决定彻底去掉问候语：删除 `ConversationDraftEmptyState` 组件及全部 `chat.empty.greeting.*` 文案，不再保留时间问候、字号测量与 office 模式分支。
