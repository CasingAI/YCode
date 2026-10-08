# Spec: Desktop 打包显示与 DMG 背景统一为 YCode

## 目标

打包产物的**可见品牌**统一为 `YCode`，与仓库既有的 YCode 品牌一致：打包产品名、DMG 背景图字样与运行时显示名落在同一品牌下。本 spec 以已落地的统一身份结论为前提（`desktop-product-identity-brand.md`：`productName: YCode` / `appId: dev.ycode.app`；`desktop-userdata-identity-separation.md`：`runtimeApplicationName` 收敛为 `YCode` 系、`userData` 独立为 `%APPDATA%\YCode`），本次只补齐打包显示层最后两处旧字样：`packages/desktop/package.json` 的兜底 `productName` 与 DMG 安装背景图。

## 产品规则

- 打包产品名 `productName`：生产版 `YCode`、Preview 版 `YCode Preview`。该值决定 `.app` 文件名、DMG 卷名、Windows 安装目录与开始菜单项、Linux `.desktop` 的 `Name`。定义处是 `desktop-product-identity.mjs`，已由 `desktop-product-identity-brand.md` 落地为 YCode，本 spec 不重复定义，只做一致性确认。
- `appId` 已随统一身份改为 `dev.ycode.app` / `dev.ycode.app.preview`（决定 macOS Bundle ID 与 Windows AUMID，与官方 ZCode 不再撞车）。本 spec 不把它改回旧值。
- `runtimeApplicationName` 已收敛为 `YCode` / `YCode Dev` / `YCode Preview`，`userData` 为 `%APPDATA%\YCode`（见 `desktop-userdata-identity-separation.md`）。本 spec 不把它改回 `ZCode`。
- DMG 安装背景图上的字样由 `ZCODE` 改为 `YCODE`，其余构图元素（箭头、四周装饰图标、背景色 `#f4f5f7`）保持不变。
- **继续保持历史值的字段**（数据身份 / 部署身份，改动会破坏既有安装）：
  - `linuxExecutableName` / `linuxPackageName`：`zcode` / `zcode-preview`。改了会让 apt/dnf 视为新包、断掉原地升级。
  - 协议 scheme：`zcode`。改了会断掉所有既有 deep link 与 OAuth 回调。
  - `ZCODE_HOME`、`~/.zcode` 业务数据根、`ZCODE_*` 环境变量、`@zcode/*` 包名。
- 关于面板的「上游 ZCode 版本」行指上游 fork 源，不是自身品牌，不改。

## 现状与根因

品牌改名是分两批落地的：显示层先切 YCode（UI 文案、UA、进程标题、关于面板），打包身份随后由 `desktop-product-identity-brand.md`（`appId: dev.ycode.app` / `productName: YCode`）与 `desktop-userdata-identity-separation.md`（`runtimeApplicationName` 收敛为 YCode 系、`userData` 独立）统一。但仍有两处打包显示素材漏网：`packages/desktop/package.json` 的兜底 `productName` 仍是旧值，且 DMG 背景图从未重绘。

结果是同一台机器上仍有可见的品牌错位：窗口标题、关于面板写 `YCode`，而 DMG 卷名、`.app` 文件名（绕过配置直接调用 builder 时）、安装背景图仍写 `ZCode`。

## 状态所有者与事件顺序

```text
packages/desktop/scripts/desktop-product-identity.mjs（打包身份的唯一定义处，已为 YCode）
  resolveDesktopProductIdentity(env) → { flavor, appId, productName, linuxExecutableName, linuxPackageName, ... }
    ├─ electron-builder.config.js: productName / appId / protocols / NSAppleEventsUsageDescription 只转发
    ├─ bundle.mjs: resolveAppAsarPath 用 appInfo.productFilename 推导 .app 目录（跟随 productName）
    └─ src/main/index.ts: resolveWindowsAppUserModelIdForFlavor 用 appId（不跟随 productName）

packages/desktop/src/main/desktopRuntimeEnv.ts（运行时应用名的唯一所有者，已为 YCode 系）
  runtimeApplicationName = YCode / YCode Dev / YCode Preview
    └─ index.ts: app.setName() / process.title、userData 路径、Linux StartupWMClass、ARMS 上报

packages/desktop/build/dmg_background.png + @2x.png（DMG 背景图的唯一素材，本次重绘）
```

- 打包身份只由 `desktop-product-identity.mjs` 定义（已是 YCode），`electron-builder.config.js` 不重复硬编码产品名（仅保留 `?? "ZCode"` 兜底，跟随 `productFilename`）。
- 打包身份与运行时应用名取值路径不同（前者构建期常量、后者运行时按 flavor 判定），但两者必须落在同一个品牌名下，否则再次出现本次错位。

## 接口与实现边界

- `desktop-product-identity.mjs` 已为 YCode，本次不改动：`PRODUCTION_IDENTITY` 为 `productName: YCode` / `appId: dev.ycode.app`，`PREVIEW_IDENTITY` 为 `productName: YCode Preview` / `appId: dev.ycode.app.preview`。`linuxExecutableName` / `linuxPackageName` 保持 `zcode` / `zcode-preview` 原值。
- `packages/desktop/package.json` 的 `productName` 同步为 `YCode`（electron-builder 在未显式覆盖时的兜底值，与 identity 必须一致）。
- DMG 背景图按原字样的实测包围盒（1x：`x 174..360, y 78..118`，颜色 `#333333`）擦除后重绘 `YCODE`，字高与总宽度对齐原值（1x 41px 高、187px 宽），`@2x` 按同比例生成。
- 不引入图标生成脚本：`@fiahfy/icns` 只是 devDependency，仓库没有从源 PNG 生成 icns/ico 的链路，本次不新增。

## 验收场景

1. `ZCODE_ENV=production pnpm bundle:desktop -- --os mac --arch arm64` 后，产物为 `YCode-<version>-mac-arm64.dmg`，`.app` 名为 `YCode.app`，DMG 卷名为 `YCode <version>`。
2. `ZCODE_PREVIEW_IDENTITY=1` 时产物为 `YCode Preview-<version>-...`，`.app` 名为 `YCode Preview.app`，与正式版并排安装不互相覆盖。
3. 挂载 DMG 后，安装背景图为 `YCODE` 字样，箭头与四周装饰元素位置、背景色与改动前一致，无擦除残影。
4. `Info.plist` 的 `CFBundleIdentifier` 为 `dev.ycode.app` / `dev.ycode.app.preview`（与官方 ZCode 不撞车）。
5. `.app` 内 `Contents/Resources` 的 `glm` / `tools/ripgrep` / `mobile-web` / `config` 等资源与改动前一致，架构与目标平台一致。
6. 业务数据根 `~/.zcode`、`zcode://` 深链不受影响；`userData` 独立为 `%APPDATA%\YCode`（见 `desktop-userdata-identity-separation.md`）。
7. 定向测试、`pnpm typecheck`、`pnpm lint` 通过。

## 负面边界

- 不改 `linuxExecutableName` / `linuxPackageName`、协议 `schemes`、`.zcode-install-manifest` 文件名。`appId` 与 `runtimeApplicationName` 的 YCode 取值已由 `desktop-product-identity-brand.md` 与 `desktop-userdata-identity-separation.md` 定义，本 spec 不重复定义、也不改回旧值。
- 不改关于面板的「上游 ZCode 版本」行，也不改 `ZCODE_*` 环境变量名、`@zcode/*` 包 scope、`zcode-builtin.json` 路径、`ZCode Protocol/1` 版本串。
- 不重画图标资源：现有整套图标（`build/icon*`、`public/logo/icons/*`、web favicon）是改名后专门换的，本次不动。
- DMG 背景图是程序化近似重绘（Helvetica Neue bold，字高与总宽度对齐原值），不是设计稿；如需精确复刻原字体需设计侧出图替换。
- 不重新构建或替换已安装的 `/Applications/ZCode.app`，不清理工作区其它未提交改动。
