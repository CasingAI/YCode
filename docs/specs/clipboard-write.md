# Spec: 剪贴板写入的唯一入口与失败可见性

## 目标

产品侧「写剪贴板」此前散落在 27 处调用点，各写各的：有的直连 `navigator.clipboard.writeText`，有的带 `if (!navigator.clipboard?.writeText) return` 之类的 early-return。桌面远控按设计经 `http://<局域网IP>:<端口>` 暴露，属**非安全上下文**，此时 `navigator.clipboard` 整个不存在；部分内置 webview 虽暴露 API 却以 `NotAllowedError` 拒绝写入。前者让复制静默无反应，后者把失败吞进日志或空 `.catch`。

本 spec 规定唯一写入入口、非安全上下文的兜底、异常语义与失败可见性，作为所有复制入口的共同约束。

## 产品规则

- **唯一写入入口**。产品侧（`packages/ui/src`）一切写剪贴板只经 `packages/ui/src/lib/clipboard.ts` 的 `writeTextToClipboard(text): Promise<void>`；调用点不得直接访问 `navigator.clipboard.writeText`。`lib/clipboard.ts` 自身实现除外。
- **兜底**。`writeTextToClipboard` 优先走异步 Clipboard API；API 不存在、或存在但抛出（如 `NotAllowedError`）时，回退 `execCommand("copy")`。
  - 兜底 textarea 必须 `readonly`，否则触屏会弹出软键盘遮挡远控界面（与 `pickerFocus.ts` 的取舍同源）。
  - 用 `fixed` + 1px + `opacity: 0` 挂载而不是 `display: none`——隐藏元素选区落空，`execCommand` 会返回 false。
  - 结束后把焦点还给原元素，不打断正在输入的输入框。
- **异常语义**。`writeTextToClipboard` 成功 `resolve`；API 与 `execCommand` 两条路径都失败时 `reject(Error("clipboard-write-unavailable"))`。`clipboard.ts` 只负责「写 + 抛」，不弹提示、不依赖 React 或 i18n——它被 node 测试直接 import，不得引入 DOM 之外的运行时依赖。
- **失败可见性**。每个调用点必须 `catch` 并给出可见反馈，最小形态是 `toast(...)`（`packages/ui/src/components/ui/toast.tsx`，页面顶部弹出通知）；已有专属失败文案的点沿用原键，无专属键的点统一用 `clipboard.copyFailed`。仅写 `logger` 不算可见。失败提示统一加在调用层，不是 helper 内。
  - 调用层收敛 helper `packages/ui/src/lib/clipboardFeedback.ts` 的 `copyTextToClipboard(text, formatMessage, logScope)` 属于调用层：它内部先 `await writeTextToClipboard`，失败时记 `logger.warn` 并弹统一 `clipboard.copyFailed` toast（`{ variant: "warning" }`），成功返回 `true`、失败返回 `false`（且已提示）。`lib/clipboard.ts` 仍只负责「写 + 抛」，不弹提示、不依赖 React 或 i18n——`copyTextToClipboard` 只是把「记日志 + 失败 toast」这层重复写法收敛到一处，供需要成功态反馈的调用点复用（当前仅 2 个 saved-workflows 文件使用），与「提示加在调用层」不冲突。
- **不改变成功路径的可见性**。原本成功后有 toast / 打勾 / `setCopied` 等反馈的点，反馈方式与时机不变；成功提示必须在 `await writeTextToClipboard(...)` 之后触发，避免「文案已成功、写入却失败」的假成功。

## 接口

- `packages/ui/src/lib/clipboard.ts`：`writeTextToClipboard(text: string): Promise<void>`。签名与抛错字符串 `clipboard-write-unavailable` 稳定，调用方不得依赖内部实现。
- 提示统一走 `packages/ui/src/components/ui/toast.tsx` 的 `toast(message, { variant: "warning" })`。
- 新增 i18n 键 `clipboard.copyFailed`（zh-CN：`复制失败：{error}`；en-US：`Copy failed: {error}`），zh-CN 与 en-US 必须同步。

## 状态所有者与事件顺序

无新增状态。写入是一次性的异步操作，所有者是发起复制的调用点；`writeTextToClipboard` 不持有跨调用状态。事件顺序固定为：用户触发 → `writeTextToClipboard` → 成功分支（打勾 / 成功 toast）/ 失败分支（`logger.warn` + `toast`）。

## 负面边界

- **终端「粘贴 / 读剪贴板」不在本 spec 内**：`navigator.clipboard.readText`（`packages/ui/src/terminal/TerminalSession.tsx`）与终端粘贴路径不受约束。
- **CLI 侧剪贴板不在本 spec 内**：`apps/zcode-cli/packages/cli/src/clipboard-text.ts` / `clipboard-image.ts`（OSC 52、子进程写入）与 CLI debug 面板的本地兜底各自独立。
- **浏览器虚拟剪贴板不在本 spec 内**：`packages/desktop/src/main/browserView/browserVirtualClipboard*` 服务于内嵌浏览器页面脚本，不是用户复制。
- 不引入全局非 React 的 i18n 单例；hook / 组件从 `useZCodeIntl()` 取 `intl`，非组件模块按参数注入 `formatMessage`。
- 不做按钮内红叉等自定义失败视觉：失败反馈统一为 toast。

## 验收

1. 模拟非安全上下文（`navigator.clipboard` 不存在）时，复制代码块、Markdown 表格、文件路径、工作流脚本、终端选区内容均成功写入系统剪贴板，不再静默无反应。
2. 模拟 Clipboard API 与 `execCommand` 两条路径都失败时，出现可见 toast 提示，且不产生 unhandled rejection。
3. `packages/ui/src` 内除 `lib/clipboard.ts` 外不存在 `navigator.clipboard.writeText`（由 `scripts/check-clipboard-writes.mjs` 守护）。
4. `packages/ui/test/clipboardFallback.test.ts` 与 `packages/ui/test/clipboardWriteEntry.test.ts` 全绿；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
