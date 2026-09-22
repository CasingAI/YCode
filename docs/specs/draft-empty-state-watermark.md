# 草稿空态水印

## 规则

- 新建页（会话草稿态）空态在问候语下层居中渲染一个装饰水印，内容是大号、很淡的「新建」两个字。
- 文案走 i18n key `chat.empty.watermark`：zh-CN 为 `新建`，en-US 为 `New`。新增语言必须提供该 key，否则水印会直接显示 key 名。
- 水印是纯装饰：`aria-hidden="true"`、`pointer-events-none`、`select-none`，不参与布局（绝对定位，不挤动问候语与输入框），不可被框选。
- 字号 `min(30vw, 13rem)`，随视口宽度缩放；不属于 `text-ui-*` 界面排版阶梯（与问候语 `--v4-draft-greeting-font-size` 同属刻意例外）。
- 颜色统一为 `text-foreground-subtlest` + `opacity-70`，浅色与深色主题共用同一套实现，不再按主题分叉资源。
- 底部渐隐：mask 为 `linear-gradient(to bottom, black 0%, black 35%, transparent 100%)`，文字向下自然淡出。注意停靠点是按一行文字的盒子高度定的，不能沿用旧 Z logo（约 320px 高盒子）的 `transparent 70%`，否则会抹掉字的下半截。

## 实现位置

- `packages/ui/src/v4/ConversationDraftEmptyState.tsx`：水印渲染在该组件内，随问候语一起被 `SessionPane` 在 `isDraft` 时挂到 `ConversationTimeline` 的 `emptyState` 槽位。
- locale：`packages/ui/src/i18n/locales/zh-CN.ts`、`en-US.ts`，加在 `chat.empty.greeting.*` 附近。

## 历史说明

- 2026-09 之前水印是 ZCode 的 Z logo（浅色内联描边 SVG + 深色 `assets/Z.svg` 位图）。改为文字水印后，`assets/Z.svg` 已删除；需要恢复时从 git 历史找回。
