# Spec: Bash 工具 description 必填与展示

## 目标

`Bash` 工具的 `description` 参数原本可选，模型经常省略，导致聊天流里的工具卡片只能显示裸命令，用户要自己读懂 `curl -s url | jq '.data[]'` 这类命令在干什么。

本次改动把 `description` 从可选改为必填，并在 UI 上把它作为 Bash 工具卡片的主文案展示。

## 产品规则

- `BashInputSchema.description` 是必填字符串。provider 侧 JSON Schema 的 `required` 因此包含 `description`，模型必须提供。
- 必填校验发生在 runtime input 校验（`normalizeToolExecutionInput` → `runtimeInputSchema`）。缺失时按现有失败路径返回结构化工具失败（`runtimeValidationIssues`），模型可以在下一轮补齐，不抛异常、不静默兜底。
- 展示规则（`ExecuteToolCallBlock`）：
  - 有 `description`：摘要区只渲染 description 一行（`text-foreground-subtle`），**不展示命令原文**。
  - **description 不省略**：description 不加 `truncate`，超出容器宽度时换行完整展示，用户不必展开卡片就能看清这一步在做什么。同时开启 `prioritizePrimaryText`，窄屏优先把宽度让给正文而不是 kind 文案。
  - 命令原文不进摘要：它在展开态详情区以 `font-mono` 完整展示（悬停 tooltip 也能拿到）。摘要里再放一份只会把卡片撑成多行，正是要避免的形态。
  - 无 `description`（历史会话、非 Bash 的 shell 家族输入）：行为与改动前完全一致，回退到 `title` / `kind` / i18n `execute.execute`；Bash 的 `title` 在缺 description 时即命令原文，这类老卡片仍会显示命令。
  - 悬停 tooltip 取 `description`，缺省时退回命令原文。
  - `isOfficeMode` 不展示 description，与 office 模式现有的精简摘要约定一致。
- 多命令聚合卡片（`ExecuteGroupToolCallBlock`）不改：子卡片各自展示自己的 description。
- description 是模型生成的自由文本，不新增 i18n key。
- 字段提示（`BASH_DESCRIPTION_FIELD_PROMPT`）要求 description 用用户当前语言书写（`written in the user's language`），与 `node_repl` 的 title、workflow 阶段名等既有的同类要求一致。语言取自当次对话上下文，不为此新增会话级语言配置。
- `bash-metadata.ts` 里既有的 `description || command` 兜底（后台任务标题、activity 文案）保持不变，继续容忍缺失。

## 接口

- schema：`@zcode/contracts` `tools/bash.ts` → `BashInputSchema`（唯一 schema 源，`BashInputJsonSchema` 由它派生；`createBashInputJsonSchema` 只覆盖 `timeout` 描述，不触碰 `description`）。
- UI：`packages/ui/src/ToolCallBlocks/renderers/execute.tsx` → 新增导出 `getExecuteDescription(input)`，与既有 `getExecuteSecondaryText` 同风格。

## 验收场景

1. 调用 `Bash` 时不传 `description` → runtime 校验失败，返回结构化工具失败。
2. 传了 `description` → 工具卡片摘要区只显示 description，换行完整展示且不出现省略号，卡片上看不到命令原文；窄屏下 kind 文案（"终端"）先隐藏。
3. 回放不含 `description` 的历史会话 → 卡片渲染与改动前一致，不出现空白主文案。
4. 命令为空但 description 存在 → 摘要行只显示 description，不报错。
