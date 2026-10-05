# 桌面窗口合成层失效兜底重绘

## 当前规则

- 带宿主合成材质的平台（Windows Acrylic、macOS `vibrancy: under-window`）在窗口 resize、hide/show、从最小化还原、从后台或被遮挡状态重新激活时，请求一次完整窗口重绘（`webContents.invalidate()`，并在 32ms 后再补一帧）。
- 重绘只作用于光栅化：不 reload renderer、不动会话、不动滚动状态。
- Linux（frameless + `transparent`）不启用；其他平台同样不启用。
- 事件集合由 `packages/desktop/src/main/windowCompositingRepaint.ts` 的纯函数给出，`desktopWindowChrome.ts` 只负责绑定。

## 实现位置

- `packages/desktop/src/main/windowCompositingRepaint.ts`：`resolveWindowCompositingRepaintEvents(platform)`，纯函数，无 Electron 依赖。
- `packages/desktop/src/main/desktopWindowChrome.ts`：`attachWindowCompositingRepaint(targetWindow)`，创建主窗口时调用一次。
- `packages/desktop/test/windowCompositingRepaint.test.ts`：钉住三个平台的事件集合。

## 历史说明

- 2026-10-05 新建页问候语（`ConversationDraftEmptyState`）在桌面端偶发只剩一层很淡的字影。已在真实 Chromium 里用同一份组件核对：字号 30px、浅色主题下前景色 `oklch(26.9% 0 0)`、`opacity: 1`、无 mask/filter，且页面里没有任何元素与它重叠——与页面样式无关，是宿主合成 surface 停住后 renderer 局部没重新光栅化的残影。
- 同类问题在 Windows 上已修过（Acrylic 窗口 hide 到托盘再 show 时只剩宿主底色），当时把兜底硬门在 `process.platform !== "win32"` 就直接返回，macOS 的 vibrancy 窗口没有同等保护。这次把同一套有界双帧重绘按平台展开，并补上 macOS 特有的 focus/restore 触发路径。
