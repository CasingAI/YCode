# Spec: Desktop 关于面板展示产品版本号

## 目标

让 Desktop 关于面板在开发态展示产品版本号（仓库根 `package.json` 的版本），而不是 Electron 运行壳版本。

## 产品规则

- 关于面板的版本号按固定顺序取值：打包元数据 `build-meta.json` 的 `appVersion` → 编译期注入常量 `ZCODE_VERSION` → `app.getVersion()`。
- 前两级都缺失时才使用 `app.getVersion()`，此时取值可能不是产品版本，属于兜底。
- 取值中的空串视为缺失，继续向下一级回退。
- 打包态与开发态使用同一套顺序；打包态下 `build-meta.json` 与安装包内 `package.json` 的版本一致，展示结果不因本次改动发生变化。
- 版本取值不影响关于面板的 Commit、Build Time、Environment 与 Electron / Chromium / Node / V8 等运行时信息，这些字段各自沿用既有的独立取值链。

## 现状与根因

`createAboutSnapshot` 已经按「显式传入值 → `buildMetadata.appVersion` → `ZCODE_VERSION`」的顺序取值，但 `showAboutDialog` 无条件传入 `app.getVersion()`，占住了优先级最高的一级，后两级永远轮不到。

开发态下 `app.getVersion()` 返回的是 Electron 运行壳版本。Electron 的文档定义是：读取应用 `package.json` 的 `version`，读取不到时返回当前 bundle 或 executable 的版本。Desktop 是 workspace 内部包，`packages/desktop/package.json` 没有 `version` 字段；开发壳的 `Info.plist` 只带 Electron 自身的版本，因此命中了回退分支。

打包态不受影响：`electron-builder.config.js` 通过 `extraMetadata.version` 把产品版本写入安装包自己的 `package.json`，所以正式应用里 `app.getVersion()` 本就等于产品版本。

## 状态所有者与事件顺序

```text
Desktop main about.ts（版本取值的唯一所有者）
  → readBuildMetadata()：读 out/metadata/build-meta.json
  → resolveAboutAppVersion(buildMetadata, app.getVersion())
  → createAboutSnapshot()
  → aboutWindow 渲染版本行与详细信息
```

- 版本取值逻辑集中在 main 进程 `about.ts`，renderer 不参与，也不自行读取版本。
- `readBuildMetadata` 读文件的既有优先级保持不变，仍以打包前生成的 `build-meta.json` 为准。
- `app.getVersion()` 在开发/预编译态可能返回运行壳版本，仅作为末位兜底，不再抢占优先级。

## 接口与实现边界

- `packages/desktop/src/main/about.ts` 新增并导出纯函数 `resolveAboutAppVersion(buildMetadata, electronAppVersion, compiledVersion = ZCODE_VERSION)`，负责上述取值顺序，不依赖 Electron 运行时。`compiledVersion` 允许注入，使三级回退顺序在单测中均可覆盖：非构建环境下模块常量恒为 `"0.0.0-dev"`，末级分支无法通过真实编译常量触达。
- `showAboutDialog` 改为先读取一次 `buildMetadata`，解析出产品版本后再传给 `createAboutSnapshot`。
- `createAboutSnapshot` 内部的既有取值语义不变：调用方显式传入 `appVersion` 时仍以传入值为准。
- `packages/desktop/package.json` 不新增 `version` 字段，避免产品版本出现第二份副本。
- 预编译启动链路 `scripts/start-desktop-prebuilt.mjs` 与其戳文件逻辑不变。

## 验收场景

1. 开发态打开关于面板：版本行显示产品版本号（当前为 `3.14.0`），不再显示 Electron 版本（当前为 `41.0.3`）。
2. 开发态展开关于面板详细信息：Commit、Build Time、Environment 与各运行时版本正常显示，未因本次改动变为空或 `unknown`。
3. 关于面板展示的版本与 `index.ts` 中遥测 / TTFT 导出的版本一致。
4. 打包元数据缺少 `appVersion` 时回退到 `ZCODE_VERSION`；两级都缺失时回退到 `app.getVersion()`。
5. 取值链中遇到空串时跳过该级继续回退，而不是展示空版本号。
6. 定向测试、类型检查、Lint 与架构检查通过。

## 负面边界

- 不修改 `autoUpdater.ts` 的开发态版本覆盖逻辑；那里为复现升级流程单独覆盖 `currentVersion`，属于独立机制。
- 不修改 `index.ts` 中遥测、灰度配置与 TTFT 导出的 `ZCODE_VERSION || app.getVersion()` 取数。
- 不给 `packages/desktop/package.json` 补 `version` 字段，不改 `electron-builder.config.js` 的 `extraMetadata.version`。
- 不改关于面板的 UI 布局、窗口尺寸、文案与多语言资源。
- 不重新构建预编译产物，不改 `readBuildMetadata` 的读文件优先级与 `resolveElectronBuilderVersion`。
- 不处理 `/Applications/ZCode.app` 等已安装的正式应用。
- 不清理或覆盖工作区其它未提交改动。
