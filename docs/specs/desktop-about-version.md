# Spec: Desktop 关于面板产品版本

## 目标

保证 Electron 原生 About 面板展示产品版本，而不是开发壳的 Electron 版本，并为诊断导出保留完整构建与运行时信息。

## 产品规则

- 原生 About 面板的产品版本按顺序取值：打包元数据 `build-meta.json` 的 `appVersion` → 编译期注入常量 `ZCODE_VERSION` → `app.getVersion()`。
- 空字符串视为缺失，继续向下回退。
- 打包态与开发态使用同一顺序。开发壳可能让 `app.getVersion()` 返回 Electron 版本，所以它仅为兜底。
- 完整 Commit、Build Time、Environment 与 Electron / Chromium / Node / V8 / OS 信息仍由 `createAboutSnapshot` 和 `formatAboutDetail` 提供给诊断导出，不在原生 About 面板展示。

## 状态所有者与事件顺序

```text
Desktop main about.ts
  → readBuildMetadata()
  → resolveAboutAppVersion(buildMetadata, app.getVersion())
  → app.setAboutPanelOptions({ applicationName, applicationVersion, copyright, iconPath })
  → app.showAboutPanel()
```

版本取值在 main 进程完成；Electron / 操作系统拥有面板展示与关闭生命周期。

## 接口与实现边界

- `resolveAboutAppVersion` 是纯函数，不依赖 Electron，可单独验证所有回退路径。
- `showAboutDialog` 从打包元数据读取一次版本和诊断信息，设置 About 面板选项后调用 Electron 原生 API。
- 不创建 BrowserWindow，不自行维护面板实例、关闭流程、位置或 modal 状态。
- 不向 Desktop 包元数据重复添加产品版本字段。

## 验收场景

1. 开发态原生 About 面板显示产品版本，不显示 Electron 壳版本。
2. 打包元数据缺少版本时依次回退到 `ZCODE_VERSION` 与 `app.getVersion()`。
3. 空字符串跳过当前级，继续回退。
4. 诊断导出仍可显示 Commit、Build Time、Environment 与运行时信息。
