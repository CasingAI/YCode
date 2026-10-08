# Spec: Desktop 打包身份与可见名称统一为 YCode

## 目标

让安装包与运行中的应用在用户可见处统一自称 YCode：安装包文件名、安装目录、开始菜单/桌面快捷方式、可执行文件名、文件属性里的产品名与公司名、应用内对话框与右键菜单文案。不再出现界面上写 YCode、系统里写 ZCode 的割裂。

同时保证安装器不再把「官方 ZCode 正在运行」当成阻塞条件——安装器检测的是自己产品的可执行文件名，改名后检测目标是 `YCode.exe`。

## 现状与根因

仓库此前的品牌改名（`desktopRuntimeEnv.ts` 的显示名/数据名解耦、`about.ts`、i18n 菜单、User-Agent）都发生在**界面层**，没有动**打包身份层**。打包身份由 `packages/desktop/scripts/desktop-product-identity.mjs` 的两个常量对象独占，electron-builder 与主进程都从这里取值：

- `electron-builder.config.js` 把 `productName` 写进产物，派生出 `ZCode.exe`、`ZCode-<version>-win-x64.exe`、安装目录、快捷方式名称、安装器运行检测目标。
- 同一份 `appId` 既进 electron-builder（决定 NSIS 卸载注册表 GUID、macOS bundle id），也进主进程 `app.setAppUserModelId`（Windows 任务栏/快捷方式 AUMID）。
- 界面层改名后，`renderer/index.html` 的 `<title>` 与关于面板已经是 YCode，于是形成"界面 YCode、系统 ZCode"的割裂。

`docs/specs/desktop-about-brand-icon.md` 曾把这一割裂明确列为负面边界，本次正是要消除它。

## 产品规则

- `productName` 是**唯一**的可见产品名来源：production 为 `YCode`，preview 为 `YCode Preview`。安装包名、可执行文件名、安装目录、快捷方式、文件属性全部由它派生，不另设第二处。
- `appId` 与 `productName` 同源改动：production 为 `dev.ycode.app`，preview 为 `dev.ycode.app.preview`。改 `appId` 是为了让 NSIS 卸载注册表项、macOS bundle id 与 AUMID 不再与官方 ZCode 撞车。
- 显示身份与数据身份继续解耦：`userData` 目录、`ZCODE_HOME`、`~/.zcode`、`ZCODE_*` 环境变量、`@zcode/*` 包名、深链 scheme、Linux 可执行名与包名一律沿用历史值，改名不迁移、不丢失用户数据。
- 删除产品名与数据身份之间的隐式耦合：凡是"用户看到的名字"，取值都应与 `productName` 语义一致，不再出现界面写 YCode、系统写 ZCode。

## 状态所有者与接口

打包身份的唯一 owner 是 `packages/desktop/scripts/desktop-product-identity.mjs` 的 `PRODUCTION_IDENTITY` / `PREVIEW_IDENTITY`。消费方两处，都通过既有导出的 `resolveDesktopProductIdentity` / `resolveWindowsAppUserModelIdForFlavor` 取值，不新增接口、不改函数签名：

```text
desktop-product-identity.mjs (appId / productName, 唯一 owner)
  ├─ electron-builder.config.js  → productName / appId / extraMetadata
  │     └─ NSIS 安装器、快捷方式、exe 版本资源、卸载注册表 GUID
  └─ main/index.ts (app.setAppUserModelId)
        └─ Windows AUMID，必须与 electron-builder 的 appId 一致
```

`packages/desktop/package.json` 的 `productName` 是 electron-builder 的兜底值，必须与 owner 保持一致；配置里的 `productName` 覆盖它，但两份不一致会在绕过配置直接调用 builder 时露出旧名。

应用内可见文案各自持有本模块的常量，不存在跨模块常量，逐处改字面量：

- `desktopOAuthDeepLink.ts` 的 `resolveExternalWorkspaceOpenDialogCopy`：外部链接确认框标题与正文。
- `desktopWindowsOpenFolderContextMenu.ts` 的 `MENU_LABELS`：Windows 资源管理器右键菜单项。
- `desktopFinderOpenFolderWorkflow.ts` 的 `SERVICES_MENU_LABELS`：macOS Finder 服务菜单项。
- `windowsCuaOperationIndicatorContent.ts` 的 `indicatorCopy`：Windows CUA 操作提示条。
- `mobileRemoteControlService.ts` 的 `serverInfo.name`：手机远控页显示的服务名。
- `WorkspaceShellLayout.tsx` 的窗口标题前缀。
- `packages/web/src/auth/webAuthLocale.ts` 的 `brand`：Web 远控登录页品牌名。
- `packages/desktop/build/installer.nsh` 的 `DetailPrint` 前缀与安装器/卸载器日志文件名：安装器"详情"面板逐行显示 `YCode: install-started` 等阶段，这些行直接呈现给用户，必须跟随产品名。

CUA 提示条的卡片宽度是按文案长度标定的：`YCode` 与 `ZCode` 字符数相同，中英文两处宽度值不需要重新校准。若后续文案长度变化，必须同步复核 `indicatorWindowSize` 的宽度。

## 负面边界

本次明确不改，改了会破坏数据兼容或扁平化本应存在的分层：

- 数据身份：`userData` 目录名与 `runtimeApplicationName` 已由 `desktop-userdata-identity-separation.md` 单独改为 YCode，本 spec 不重复定义；`ZCODE_HOME`、`~/.zcode`、`ZCODE_DATA_BASE_DIR` 仍沿用历史值。
- 内部标识：`ZCODE_*` 环境变量、`@zcode/*` 包名与目录名、TypeScript 类型与函数名、`ZCode Protocol` 字符串、遥测事件值。
- 深链与注册表键名：`zcode://` scheme、Windows 右键菜单注册表键 `ZCode.OpenInZCode`、macOS Finder workflow 的目录名 `Open in ZCode.workflow` 与 bundle id `dev.zcode.app.finder-open-workflow`。这些是机器标识，改字面量会让既有安装留下孤儿项。
- Linux 身份：`linuxExecutableName` / `linuxPackageName`、`StartupWMClass`、`LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER`，以及 `packages/desktop/package.json` 的 `description`（deb/rpm 的描述字段，与 Linux 身份同族，随 Linux 保持 ZCode）。实测打包产物里仅剩的 `ZCode Desktop` 字样就是这两处。
- 上游归属声明：`about.ts` 与 CLI 的 `上游 ZCode 版本` / `Upstream ZCode` / `(like ZCode/x)`、`THIRD-PARTY-NOTICES.md`、许可证与 `Modified by ZCode`。
- 模型 prompt 与 Desktop Context 标题、`ZCode-WebFetch/0.1` 等既有 spec 已排除的出站标识。
- 不改图标资源，不加运行时环境变量开关，不加设置界面，不引入新依赖。
- 禁止对仓库执行全局搜索替换；改动必须落在上述清单内。

## 风险

- 改 `appId` 会让 NSIS 卸载注册表 GUID 与 macOS bundle id 变化：已装旧包的机器上，新旧包在"应用和功能"里会各占一条，需要手动卸载旧条目。这是本次换取与官方 ZCode 并存的代价。
- `userData` 的单实例锁问题已由 `desktop-userdata-identity-separation.md` 解决（userData 独立后两者可同时运行）。但业务数据根 `~/.zcode` 仍与官方 ZCode 共用，两者会同时读写同一份凭据/会话/工作区，该风险由那份 spec 记录。
- 打包身份只在打包期生效，本地 `pnpm dev` 不经过 electron-builder，改名对开发态不可见，无法用开发态验证，必须走真实打包。

## 验收场景

1. `pnpm bundle:desktop -- --os win --arch x64` 产出 `YCode-<version>-win-x64.exe`，不再有 `ZCode-` 前缀的安装包。
2. 安装后：安装目录、开始菜单项、可执行文件均为 `YCode`；右键查看 exe 属性，产品名与公司名为 YCode。
3. 安装器在官方 ZCode 正在运行时不再弹"ZCode 正在运行"阻塞框——它检测的目标已是 `YCode.exe`。
4. 应用内可见文案无 ZCode：外部链接确认框、Windows 右键菜单项、CUA 提示条、窗口标题、Web 远控登录页品牌名。
5. 数据不迁移：升级安装后 `%APPDATA%\ZCode` 仍是同一份用户数据，登录态与窗口状态保留。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
