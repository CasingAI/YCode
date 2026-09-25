# 草稿空态装饰水印

## 当前规则

- 新建页（会话草稿态）只渲染正常问候语，不渲染文字水印、背景字样或旧 Z logo。
- 问候语继续使用 `chat.empty.greeting.*`，按当前时间或 office 模式选择文案，并根据自身可用宽度在 20–30px 之间调整字号。
- 草稿空态与底部输入区的现有间距保持不变；移除装饰层不得改变时间线、底部 Dock 或输入框的布局协议。

## 实现位置

- `packages/ui/src/v4/ConversationDraftEmptyState.tsx`：仅负责问候语选择、宽度测量和渲染，由 `SessionPane` 在 `isDraft` 时挂到 `ConversationTimeline` 的 `emptyState` 槽位。
- `packages/ui/src/i18n/locales/zh-CN.ts`、`en-US.ts`：保留 `chat.empty.greeting.*`，不再定义 `chat.empty.watermark`。

## 历史说明

- 2026-09 之前草稿空态使用 ZCode 的 Z logo（浅色内联描边 SVG + 深色 `assets/Z.svg` 位图）；改为文字水印后，`assets/Z.svg` 已删除。
- 2026-09-23 水印改为大号「新建」文字，并通过纵向 mask 尝试渐隐。该文字盒相对只有单行问候语高度的父容器绝对居中，必然覆盖问候语中心；移除 mask 后仍可稳定观察到问候语横穿水印中部。
- 2026-09-25 用户选择直接移除水印，而不是继续依赖字号、魔法偏移、遮罩或额外覆盖层规避重叠。
