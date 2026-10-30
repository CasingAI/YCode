# EmojiPickerDialog 浏览器夹具

独立 Vite 站点，直接渲染真实 `EmojiPickerDialog`（真实 `DialogContent` 外壳）、真实
`EmojiPickerPanel`（Frimousse）、真实 `TaskGroupTag` / `TaskGroupColorMark` 与
`EmojiGlyph`，用真实 `ZCodeIntlProvider`（zh-CN / en-US）和真实 `styles.css` 验证
本地 emojibase 数据与本地 Noto PNG。不接入 YCode UI，不启动桌面端或 Web 应用，也不
访问任何现有服务。

- 夹具源码：本目录
- 构建产物：系统临时目录 `zcode-emoji-picker-e2e`（可用 `EMOJI_E2E_DIST` 覆盖；build / serve / verify 必须一致）
- 端口：开发 `43117`，静态预览 `43118`（均绑定 `127.0.0.1`）
- 资源插件：与生产一致通过公开入口 `@zcode/ui/vite/noto-emoji-assets` 注册（开发中间件 / 构建 emit）
- 生产构建 `base: "./"`，覆盖 Desktop 的相对 BASE_URL；PNG 输出到扁平 `noto-emoji/`

## 静态模式（推荐）

```bash
mise exec -- pnpm exec vite build --config packages/ui/test/fixtures/emoji-picker-browser/vite.config.mts
mise exec -- node packages/ui/test/fixtures/emoji-picker-browser/serve.mjs
# http://127.0.0.1:43118/
```

## 开发模式

```bash
mise exec -- pnpm exec vite --config packages/ui/test/fixtures/emoji-picker-browser/vite.config.mts
# http://127.0.0.1:43117/
```

## 构建 / 运行时断言

```bash
# 构建产物：locale 分包、相对 chunk 引用、3998 张独立 PNG 不内联
mise exec -- node packages/ui/test/fixtures/emoji-picker-browser/verify-graph.mjs
# 可选：同时检查已启动的 dev / prod HTTP 服务
EMOJI_E2E_DEV_URL=http://127.0.0.1:43117 EMOJI_E2E_PROD_URL=http://127.0.0.1:43118 \
  mise exec -- node packages/ui/test/fixtures/emoji-picker-browser/verify-graph.mjs
# 真实 resolver 零 fetch、zh/en 构建数据可消费
mise exec -- node packages/ui/test/fixtures/emoji-picker-browser/verify-runtime.mjs
```

## 浏览器自检（?autorun=1）

打开 `http://127.0.0.1:43117/?autorun=1`（或 `43118`）后，页面在真实 Dialog 上依次执行：

- zh / en 各一轮：打开 → 断言真实 Dialog 外壳（桌面 320px / 内容盒 286px；窄视口贴合
  `100%-2rem`）→ 搜索（火箭 / rocket）→ 真实 `button.click()` 选取 → 自动关闭 →
  再次打开；
- 选中后真实 `TaskGroupTag`（完整 + 紧凑）与 `TaskGroupColorMark` 内的本地 PNG
  必须 `complete` 且 `naturalWidth > 0`，且不再输出 emoji 字符文本；
- 未知字符夹具必须回落到中性 Lucide 图标，不输出原字符、不请求不存在资源；
- Dialog / Frimousse Root / Viewport / List 与页面均无横向溢出；
- 证据：无外部网络请求、无 `console.error`、无 frimousse storage key。

结果输出到 `#e2e-report`（PASS/FAIL）、`window.__e2eResult`、`#e2e-result-json`、
`document.body.dataset.e2eStatus` 和 `document.title`。人工/浏览器工具只需读页面上可见的
`#e2e-status`（`PASS n/n` / `FAIL n/n`）与 `#e2e-lines`（逐条断言及 `viewport=… shell=…
contentBox=…`），不需要读取 window 内部字段。报表右上角的「收起/展开」只折叠明细，
保留一行状态；窄视口截图前先收起，避免固定报表遮住真实 Dialog。

视口必须由浏览器工具设置真实整页 viewport，不能用窄 CSS 容器模拟：

```js
await tab.setViewportSize({ width: 1280, height: 800 }); // 普通桌面
await tab.setViewportSize({ width: 320, height: 720 }); // 窄视口（工具最小 320x320）
```

设置后重新打开 `?autorun=1`（断言在页面加载时读取真实 `innerWidth`）。桌面
（≥640px，Tailwind `sm`）断言真实 `DialogContent` 外壳 320px、内容盒 286px；窄视口断言
外壳为 `viewportWidth - 32`（320px 视口即 288px），且 Dialog/Frimousse/页面均无横向溢出。
`zh` 结束时保留对话框打开，便于截图复核；`en` 结束时关闭。

生成物全部在仓库外；验证后删除临时目录即可，不需要改 `.gitignore` 或拷贝 `node_modules`。
