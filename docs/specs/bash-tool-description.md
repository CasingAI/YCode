# Spec: Bash 工具 description 必填与展示

## 目标

`Bash` 工具的 `description` 参数原本可选，模型经常省略，导致聊天流里的工具卡片只能显示裸命令，用户要自己读懂 `curl -s url | jq '.data[]'` 这类命令在干什么。

本次改动把 `description` 从可选改为必填，并在 UI 上把它作为 Bash 工具卡片的主文案展示。

## 产品规则

- `BashInputSchema.description` 是必填字符串。provider 侧 JSON Schema 的 `required` 因此包含 `description`，模型必须提供。
- 必填校验发生在 runtime input 校验（`normalizeToolExecutionInput` → `runtimeInputSchema`）。缺失时按现有失败路径返回结构化工具失败（`runtimeValidationIssues`），模型可以在下一轮补齐，不抛异常、不静默兜底。
- 展示规则（`ExecuteToolCallBlock`）：
  - 有 `description`：摘要区只渲染 description（`text-foreground-subtle`），**不展示命令原文**。
  - description 是独占摘要行的单行文本：使用 `truncate` 保持工具行高度稳定，超出可用宽度时显示省略号，不换行占满多行。同时开启 `prioritizePrimaryText`，窄屏优先把宽度让给正文而不是 kind 或来源文案。
  - 命令原文不进摘要：它在展开态详情区以现有详情样式展示。摘要里再放一份会重复信息并挤占 description 空间。
  - 无 `description`（历史会话、非 Bash 的 shell 家族输入）：行为与改动前完全一致，回退到 `title` / `kind` / i18n `execute.execute`；Bash 的 `title` 在缺 description 时即命令原文，这类老卡片仍会显示命令。
  - 摘要行的 `title` 继续沿用 `toolCall.title ?? description ?? secondaryText` 的现有回退顺序，本次不改变其来源。
  - `isOfficeMode` 不展示 description，与 office 模式现有的精简摘要约定一致。
- description 是模型生成的自由文本，不新增 i18n key。
- 字段提示按**会话语言**生成（`buildBashDescriptionFieldPrompt`）：会话配置里携带语言时，提示里显式点名该语言（如「必须用简体中文书写，不要使用其他语言」），且三条示例同步换成该语言；会话没有语言时退回原有的 `written in the user's language` 英文文案，行为与本次改动前逐字节一致。语言来源见 `docs/specs/session-language.md`。
  - 为什么示例也要跟着换：只改语言名而保留英文示例，等于一边要求中文一边示范英文，模型会跟示例走。
  - 该决策**取代**此前的「语言取自当次对话上下文，不为此新增会话级语言配置」：那条的前提是界面语言没有会话级载体，现已由会话语言配置提供。
  - `node_repl` 的 title、workflow 阶段名等同类「用用户语言」提示仍走对话上下文，本次不覆盖。
- `bash-metadata.ts` 里既有的 `description || command` 兜底（后台任务标题、activity 文案）保持不变，继续容忍缺失。

## 接口

- schema：`@zcode/contracts` `tools/bash.ts` → `BashInputSchema`（唯一 schema 源，`BashInputJsonSchema` 由它派生；`createBashInputJsonSchema` 只覆盖 `timeout` 描述，不触碰 `description`）。
- UI：`packages/ui/src/ToolCallBlocks/renderers/executeDescription.ts` → `getExecuteDescription(input)`（无 JSX、无路径别名的纯函数模块，`node:test` 可直接导入）。

## 验收场景

1. 调用 `Bash` 时不传 `description` → runtime 校验失败，返回结构化工具失败。
2. 传了 `description` → 工具卡片摘要区只显示 description；文本保持单行，超出可用宽度时显示省略号，卡片高度不随 description 行数增长，摘要中看不到命令原文；窄屏下 kind 文案（"终端"）先隐藏。
3. 回放不含 `description` 的历史会话 → 卡片渲染与改动前一致，不出现空白主文案。
4. 命令为空但 description 存在 → 摘要行只显示 description，不报错。
