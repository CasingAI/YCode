# Spec: Desktop 关于面板展示应用图标

## 目标

让关于面板展示真实的应用图标，与 Dock、启动台、Finder 看到的应用图标保持一致，不再显示硬编码的旧标识。

## 产品规则

- 关于面板的图标与应用图标是同一份素材，取自 `resolveAboutIconPath()` 指向的 `icon.png`：打包态为 `process.resourcesPath/icon.png`，开发态为 `packages/desktop/build/icon.png`。
- 图标在 HTML 模板里以 `data:` URL 内联渲染，不改用 `file://` 加载本地文件。
- 图标位不叠加自绘装饰。素材自带圆角与四周约一成的透明留白，容器再画圆角或投影会落在留白外圈，把那一圈背景压暗、中心相对更亮，看起来像一块浅色板托着图标。
- 图标按素材留白放大后渲染，使可见部分约 52px，与早期的内联标识视觉重量一致。素材自带留白比例变化时，这个尺寸需要同步重新校准。
- 图标文件不存在或读取失败时，省略整个图标位；关于面板的其余内容（标题、版本、Apple Silicon 行、版权、按钮）照常渲染，不报错。
- 图标为装饰元素，对无障碍树隐藏（`aria-hidden` + 空 `alt`）。
- 图标变化不影响关于面板的窗口尺寸、文案与版本取数。

## 现状与根因

关于面板是 main 进程自绘的无边框窗口：`showAboutDialog` 把 `createCustomAboutDialogHtml(...)` 的结果编码成 `data:text/html` 交给 `loadURL`（`packages/desktop/src/main/about.ts`）。

该链路里图标是**画出来的，不是读出来的**。`packages/desktop/src/main/aboutWindow.ts` 在模板中内联了一段 `<svg>`，其 path 坐标与 Z.ai 的品牌标识 `packages/ui/src/assets/provider-icons/logo-zai.svg` 一致；外层 `.app-icon` 用黑底渐变加 `border-radius` 把它衬成一枚应用图标。

与此同时，`about.ts` 的 `resolveAboutIconPath(isPackaged)` 是正确存在的，`electron-builder.config.js` 也通过 `extraResources` 把 `build/icon.png` 放到了 `resources/icon.png`。但该路径只被传给 `BrowserWindow` 的 `icon` 选项，而 `icon` 选项不参与 macOS 窗口内容渲染。

因此图标资源整体替换（例如 `ba3d23b` 一次性替换 `icon.icns` / `icon.ico` / 全部尺寸 PNG / web favicon）时，模板里的内联 SVG 毫发无损——图标资源与关于面板之间不存在取值链，两者各自漂移。

## 状态所有者与事件顺序

```text
main about.ts（关于面板图标的唯一所有者）
  → resolveAboutIconDataUrl(app.isPackaged)
      → resolveAboutIconPath(isPackaged)：打包态 resources/icon.png，开发态 build/icon.png
      → createIconDataUrl(filePath)：读文件 → data:image/png;base64,...
  → createCustomAboutDialogHtml({ ...iconDataUrl })
  → loadURL(data:text/html)
```

- 图标读取与降级集中在 main 进程 `about.ts`，模板只负责渲染，不自行读文件。
- 打包态与开发态共用同一条路径解析逻辑，路径语义与改动前一致。

## 接口与实现边界

- `packages/desktop/src/main/aboutWindow.ts` 的 `CustomAboutDialogHtmlInput` 增加 `iconDataUrl: string`；模板以 `<img>` 渲染该值，`iconDataUrl` 为空串时不输出图标容器。`.app-icon` 只保留 52×52 的居中布局占位，不加背景、圆角或投影；`.app-logo` 按素材留白放大后渲染，同样不加圆角与 `object-fit`。
- 模板 CSP 已含 `img-src data:`，不为图片放宽策略。
- `packages/desktop/src/main/about.ts` 新增并导出 `createIconDataUrl(filePath)`（文件缺失或读取失败返回空串）与 `resolveAboutIconDataUrl(isPackaged)`（组合既有 `resolveAboutIconPath`）。`resolveAboutIconPath` 本身不改。
- `BrowserWindow` 的 `icon: iconPath` 保持原样：非 macOS 平台仍依赖它设置窗口图标。
- `createIconDataUrl` 不依赖 Electron 运行时，可被 `node --test` 直接覆盖。

## 验收场景

1. 开发态打开关于面板：图标位显示 `packages/desktop/build/icon.png` 的内容，不再是黑底白「Z」；图标直接坐在面板背景上，四周没有浅色板、没有矩形阴影环。
2. 替换 `packages/desktop/build/icon.png` 后重启：关于面板图标随之变化——证明图标有唯一来源，不是复制了一份素材。
3. 移走 `packages/desktop/build/icon.png` 后重启：图标位整体消失，窗口其余内容与按钮正常，无裂图、无报错。
4. 版本行、Apple Silicon 行、版权行与按钮位置不因本次改动变化。
5. 打包后 `icon.png` 仍从 `process.resourcesPath` 解析，`resolveAboutIconPath` 的分支语义与改动前一致。
6. 定向测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

## 负面边界

- 不修改仓库内的图标资源本身（`build/icon*.png`、`build/icon.icns`、`build/icon.ico`、`public/logo/icons/*`、`public/icon_512@2x.png`、`icon-source-1024.png`、web favicon）。关于面板如实展示当前这一套。
- 不修改开发壳 bundle 的 Dock 图标。`packages/desktop/scripts/devElectronAppBundle.mjs` 只 patch `CFBundleDisplayName` / `CFBundleIdentifier` / `CFBundleName` 与 URL scheme，未设置 `CFBundleIconFile`，开发态 `YCode Dev.app` 仍用 `electron.icns`。那是开发壳构造的另一条链路，且只影响开发态；打包态已正确使用 `build/icon.icns`。
- 不统一打包身份与界面的命名差异：`desktop-product-identity.mjs` 中仍是 `productName: "ZCode"` / `appId: dev.zcode.app`，而关于面板显示 `YCode Desktop App`。
- 不改关于面板的窗口尺寸、文案、多语言资源与版本取数逻辑（后者由 `desktop-about-version.md` 覆盖）。
- 不引入 `file://` 图片加载，不放宽 CSP 到 `img-src file:`。
- 不重新构建或替换 `/Applications/ZCode.app`，不清理工作区其它未提交改动。
