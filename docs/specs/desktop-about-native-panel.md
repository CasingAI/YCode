# Spec: Desktop 使用系统 About 面板

## 目标

将自绘的关于 `BrowserWindow` 替换为 Electron / 操作系统提供的 About 面板，避免应用自行维护窗口的创建、复用、定位、模态关系与关闭生命周期。

## 产品规则

- 用户从现有菜单或命令打开“关于”时，主进程配置 Electron About 面板并调用 `app.showAboutPanel()`。
- 面板信息使用产品名 `YCode Desktop App`、产品版本解析结果、本地化版权文案，以及平台应用图标。
- 保留旧面板的 Apple Silicon 优化说明（仅 macOS arm64 显示）和上游 ZCode 版本行，放入 Electron About API 的 `credits` 信息区；版权信息继续显示在标准版权字段。
- About 面板生命周期完全由 Electron / 操作系统管理，不创建或保留专用 `BrowserWindow`，不自行处理关闭、隐藏、焦点、重叠和父窗口状态。
- About 调用不依赖活跃窗口；传入的父窗口和界面语言参数保留兼容调用签名，语言只用于本地化版权文案。
- 详细构建/运行时信息不放入 About 面板；它们继续由诊断导出提供。
- Electron 的 `credits` 仅支持 macOS / Windows；Linux About 面板使用 Electron 提供的 authors / website 字段能力，不能显示这组自定义说明。
- macOS 使用 AppKit 原生 About 面板；Windows / Linux 使用 Electron 当前平台的 About 面板实现与原生应用图标。

## 状态所有者与事件顺序

```text
菜单/命令 → Desktop main about.ts → 读取产品元数据与 locale
          → app.setAboutPanelOptions(options) → app.showAboutPanel()
          → Electron / OS 拥有展示与关闭生命周期
```

应用不持有面板窗口引用或状态，不建立第二条关闭路径。

## 接口与实现边界

- `showAboutDialog` 保持现有调用点兼容，但只读取应用信息、配置 `app` 并打开面板。
- 版本号继续复用 `resolveAboutAppVersion` 的既有优先级，不因改用原生 UI 变更。
- 删除仅服务于旧自绘窗口的 HTML、窗口定位、macOS sheet dismiss 辅助代码及其构建/打包配置。
- 版本解析及 About 文案纯函数继续保留并由测试覆盖；新增测试验证调用了 Electron 的原生 About API 和传入选项。

## 验收场景

1. 从帮助菜单打开关于面板，显示系统原生 About UI 和正确产品图标、名称、产品版本、版权文案。
2. macOS arm64 的 Credits 信息区显示 Apple Silicon 优化说明与上游 ZCode 版本；其他架构省略优化说明，未知上游版本省略对应行。
3. Windows 的 Credits 信息区可显示相应本地化信息；Linux 按 Electron 原生 API 限制展示。
4. 连续触发打开时由 Electron / OS 管理面板行为；关闭面板后无需应用代码恢复窗口状态。
5. 有无主窗口时均可打开面板，不因父窗口销毁、隐藏或 modal sheet 状态卡住。
6. 中文与英文说明正确；版本回退规则保持原有测试结果。
7. 桌面包不再准备或打包旧 macOS about sheet 原生辅助模块。
