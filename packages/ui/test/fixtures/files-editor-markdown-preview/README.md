# FilesEditor Markdown 源码/预览浏览器夹具

独立 Vite 站点，挂载真实 `FilesEditorGroupPane`、真实
`FilesEditorStoreProvider`/`filesEditorStore` 和真实 `FilesEditorTabBar`，只替换
服务边界，用于验证文件编辑器标签条右侧的 Markdown「源码 / 预览」切换。不接入运行中的
YCode，不连接桌面端、Web 应用或任何既有服务。

## 覆盖范围

- Markdown 标签默认源码视图；标签条内出现源码/预览切换。
- 编辑后切到预览：预览渲染当前 `buffer.text`（包含未保存草稿），底层编辑器以 `inert`
  隔离；切换前后源码编辑器仍是同一个 DOM 节点，不是重建后靠缓存恢复。
- 预览切回源码：草稿、dirty 与撤销/重做保持；保存按钮仍把当前草稿交给 `onSave`，
  `markSaved` 后 dirty 清除且正文不变。
- 编辑器句柄：源码态向工作台上报句柄，预览态上报 `null`，回到源码后恢复同一个句柄。
- 分屏：同一 buffer 在两个 view 中分别保持 source / preview，互不覆盖；源码侧继续编辑，
  预览侧直接渲染最新 `buffer.text`，仍只有一个真实 buffer。
- 非 Markdown（`.ts` / `.txt`）与大文本 `.md` 不显示切换控件；同组普通 Markdown 标签
  仍有控件。
- 响应式：暗色桌面（1280px）、窄屏 375/320px 与 375px 分屏下，切换/保存/拆分控件都在
  标签条内，页面与标签条无横向溢出，标签仍有可见宽度；保存操作在预览态仍可用。
- 国际化：默认 `zh-CN`，可切到最小 `en-US`；375 / 320 混合标签和窄分屏下，英文
  `Source / Preview` 控件仍可点击、活动标签标题至少保留 24px 可读区域且无横向溢出。

## 服务边界（降级说明）

真实实现部分：布局树、buffer、view、dirty、保存、标签条、GroupPane、Markdown 渲染链路
（`FilesMarkdownPreview` → `MarkdownPreviewContent`）以及真实 `styles.css` 的 Tailwind
输出。

stub 部分（仅服务/宿主边界）：

- `stubs/source-editor.tsx`：以 textarea 代替 Monaco，但按 `buffer.id` 缓存 value 与
  undo/redo 栈，模拟 Monaco model 作为撤销边界，并按模型交出同形状态栏句柄；未使用真实
  Monaco 撤销栈与状态栏实现。
- `stubs/large-text-viewer.tsx`、`stubs/preview-pane.tsx`：占位，避免加载重依赖。
- `stubs/intl.tsx`、`settings.ts`、`toast.tsx`、`logger.ts`、`store.tsx`、
  `platform.ts`：i18n、设置、Toast、日志、App store、平台服务的最小实现。
- `onSave` 只记录调用并执行 `markSaved`，不写磁盘、不经 Host / Agent 落盘。

因此本夹具证明的是 Renderer 内的切换、草稿与保存调用链路，不覆盖真实 Monaco 撤销栈、
Host 写盘和远端 workspace 行为。

## 无浏览器环境

`playwright-core` 从 `packages/desktop` 的既有依赖解析，没有新增依赖，也不会下载浏览器。
找不到 `playwright-core` 或独立 Chromium 时，`main()` 返回 `skipped`，node:test 入口用
`t.skip()` 跳过，因此 `pnpm --filter @zcode/ui test` 在没有浏览器的 CI 中不会因此失败。
可通过 `ZCODE_TEST_CHROMIUM_PATH` 等环境变量指定浏览器。

## 窄屏验收口径

375px 分屏（每侧约 187px）和 320px 三标签 + 预览 + 保存时，右侧控件会挤压标签。测试
要求活动标签标题至少保留 24px 可读区域，切换与保存按钮中心点都能命中自身（未被覆盖或
移出视口），页面与标签条无横向溢出。达到该口径需要实现侧压缩切换控件或隐藏拆分按钮；
夹具不模拟修复，也不放宽断言。

## 文件结构

- `run.mjs`：入口、构建、静态服务、浏览器生命周期与运行时错误汇总。
- `harness.mjs`：Playwright / Chromium 发现与静态服务。
- `probes.mjs`：控件扫描、点击、等待、源码编辑器和句柄状态探针。
- `layout.mjs`：标签条布局指标与响应式 / 可读标题 / 命中断言。
- `scenarios-core.mjs`：Markdown、分屏、混合标签与大文本场景。
- `scenarios-responsive.mjs`：暗色桌面、窄屏、窄分屏与 en-US 场景。

## 运行

```bash
node packages/ui/test/fixtures/files-editor-markdown-preview/run.mjs
```

或走仓库测试入口：

```bash
pnpm --filter @zcode/ui exec tsx --import ./test/helpers/registerAssetStubs.mjs \
  --test test/filesEditorMarkdownModeBrowser.test.ts
```

脚本会 Vite 构建到系统临时目录、在 `127.0.0.1` 的临时端口（`listen(0)`）起静态服务，
并用独立 Chromium 执行点击断言，输出 `PASS: n/n` 与截图路径。找不到浏览器时跳过，可用
`ZCODE_TEST_CHROMIUM_PATH`、`CHROME_BIN`、`CHROMIUM_PATH` 或
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定。

## 临时产物与清理

- 构建目录：`<tmp>/zcode-files-md-e2e-dist-*`，运行结束自动删除；设置
  `FILES_MD_E2E_KEEP=1` 可保留。
- 截图：`<tmp>/zcode-files-md-e2e-shots-*`，保留供人工复核，可按需删除。
- 静态服务与 Chromium 在 `finally` 中关闭；端口由系统分配，不与现有服务冲突。
