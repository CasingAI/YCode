# 桌面主窗口最小尺寸

## 当前规则

- 桌面主窗口最小尺寸为 **380×640**：宽度允许用户压缩到 380px，高度下限 640px。
- 该下限同时约束三处：`BrowserWindow` 创建选项（用户拖拽的硬边界）、启动还原（持久化尺寸小于下限时钳回）、尺寸持久化（保存时再次钳制）。
- 屏幕工作区小于下限时，窗口仍取下限值，不随工作区继续缩小（`clampDimension` 用 `Math.max(minimum, available)` 保证）。
- UI 层依赖窄视口（<768px）的覆盖层布局承接窄窗口：侧栏与 Side Pane 变覆盖层、会话列占满视口，见 `workspace-shell-responsive-layout.md`。该布局的参考机型为 ≤440px 的手机，380px 桌面窗口走同一套窄视口形态。
- 辅助窗口不受此规则约束：资源管理器窗口 640×420，更新提示窗口与强制更新弹窗为各自固定尺寸。

## 实现位置

- `packages/desktop/src/main/desktopWindowSize.ts`：下限常量、启动还原钳制（`resolveDesktopWindowSize`）、持久化钳制（`attachDesktopWindowSizePersistence`）。
- `packages/desktop/src/main/desktopWindowChrome.ts`：把下限常量接到 `BrowserWindow` 的 `minWidth`/`minHeight`。
- `packages/desktop/test/desktopWindowSize.test.ts`：钉住下限在三处约束中的行为。

## 历史说明

- 2026-10-08 宽度下限从 480px 放宽到 380px：UI 窄视口形态已按 ≤440px 手机目标机型完成覆盖层化改造，桌面窗口沿用同一形态即可安全下探；高度下限 640px 维持不变。
