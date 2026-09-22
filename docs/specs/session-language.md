# Spec: 会话语言

## 目标

会话在被创建时，把当时界面使用的语言（解析后的实际语言，如 `zh-CN` / `en-US`）快照进会话自己的配置。此后该值属于这个会话，不随全局界面语言变化而变，冷恢复后仍然有效。

首个消费方是 Bash 工具的 `description` 字段提示（见 `docs/specs/bash-tool-description.md`）：该提示按会话语言生成文案，并显式要求模型用该语言书写。

## 产品规则

### 取值

- 值域是 `Locale`（`zh-CN` | `en-US`，`packages/shared/src/protocol.ts` 定义），存的是**解析后的实际语言**，不是用户偏好（`LocalePreference` 里的 `system` 不进入会话配置）。
- 语义是**创建时快照，之后不变**：会话创建后用户改全局界面语言，已有会话的语言不回写、不跟随。
- 语言不是用户可以单独切换的会话开关：没有用户可见的「切换本会话语言」入口，也没有对应的会话事件。

### 缺席语义

- 语言在配置里是可选字段，**没有默认值**。旧会话（本次改动前创建）读不到该字段。
- 缺席时所有消费方都必须安全回退：Bash 字段提示退回原有的 `written in the user's language` 英文文案，不得报错、不得凭全局界面语言补值（补值会让"旧会话"和"当时是中文"变得无法区分）。
- 快照 schema 解析旧数据不得因缺字段失败。

### 状态所有者

- **真值**：CLI runtime 的 `AgentRuntimeConfig.language`（`apps/zcode-cli/packages/core/src/runtime/types.ts`）。工具契约与后续消费方一律读它。
- **持久化**：会话级 session entry `runtime/session_language`，随会话存档；冷恢复据此还原。
- **fork**：语言是**重新快照**而非继承。fork 的通则是「延续对话、重新加载环境」——新 runtime 构造时从磁盘现读 MCP / subagent / 插件 / hooks / features，用户改完这些后老会话读不到、fork 就能读到；语言属同一类环境配置（不是用户在会话里做的选择，与 mode/model/thoughtLevel/followupMode 的「会话选择继承」例外不同），因此 `forkAssistant` 与 `createSelectionSideSession` 命令携带 fork 那一刻的界面语言，写入 child。core 的 fork 只复制 verification 类 session entry，语言 entry 不随 fork 落库，所以无论来源都要由 `registerForkedSession`（`server-operations.ts`）显式写入；旧客户端未携带 language 时回退继承父会话语言（避免 fork 出的中文对话退回英文提示）。
- **投影**：`ConversationSnapshot.config.language`（`SessionConfigState`）是 runtime 真值的投影，经现有 `SessionConfigSeed` 通道注入，不新增第二条写路径。
- 界面语言本身（全局）仍然只属于 `setting.json` 的 `locale` / `localePreference`，本机制只**读**它一次，绝不回写。

## 接口

- 协议：`createSession.config.language`（请求侧）、`SessionConfigState.language`（投影侧），均为可选 `Locale`。
- 创建点：新会话有几个创建点，**每个创建点都必须携带 language**，缺一即为丢失：直接提交的 `createSession`、草稿预热路径的 `createSession`（`buildPrewarmInitialDraftConfig`，SessionPane 把当前界面语言经 `useDraftConfigControl` 的 `language` 参数传入）、`createSelectionSideSession`、`forkAssistant`。预热路径尤其关键：它是「新建对话」的常规创建点，首发消息只做提升、不再补发 `createSession`，所以漏带就没有第二次机会。语言不依赖草稿里是否有 mode/model 选择，无选择时也要单独携带。
- runtime：`setSessionLanguage(language)`（同值早返回；无 active turn 时重建 context 前缀；落 session entry）。
- 应用点：`applyRequestedSessionConfig` 在会话创建后应用请求 config；应用失败只 warn，不连坐创建失败。
- 恢复点：冷恢复从 session entry 还原；晚于 context 构建则无效，必须在其之前。
- fork 点：`forkAssistant` / `createSelectionSideSession` payload 的可选 `language` → Host capability → `registerForkedSession` 在 `resume()` 之后写入 fork runtime 并落成 fork 自己的 session entry（resume 之前 `sessionPersisted` 仍为 false，写入会被跳过而不落盘）；未携带时回退继承父 runtime 语言。
- 工具侧：`ToolExecutionModelContext.language` 由 `getTools()` 从 runtime config 注入，Bash 用具它经 `resolveModelContract` 生成字段提示。
- 语言名映射：不另设全局映射表。提示文案按语言整块提供（`buildBashDescriptionFieldPrompt`：`BASH_DESCRIPTION_FIELD_PROMPT_BY_LANGUAGE` 以会话语言为键），因为「要求用某语言」的措辞和示例必须同属一种自然语言，无法由「语言名」字符串拼出来；未识别的语言标识回退默认英文文案。

## 验收场景

1. 界面语言为 English 新建会话 → 该会话 Bash `description` 提示要求英文。
2. 界面语言为简体中文新建会话 → 该会话 Bash `description` 提示要求简体中文，且示例为中文。
3. 创建时为中文的会话，重启客户端后恢复 → Bash `description` 仍要求中文。
4. 本次改动前创建的历史会话 → 提示文案与改动前完全一致（英文 `in the user's language` 块），不出现空白或报错。
5. 在语言为中文的会话里把全局界面语言改成 English → 该会话仍要求中文；另开的新会话要求英文。
6. 会话快照的 `config.language` 等于创建时的解析语言；旧会话该字段缺省且 schema 校验通过。
7. 父会话创建时是中文、之后把全局界面语言改成 English 再点 fork → fork 出的会话语言为 English（fork 那一刻的界面快照）；旧客户端（命令不带 language）fork → 继承父会话的中文。
8. 「新建对话」流程（草稿预热路径）：界面语言为简体中文、**未选任何草稿配置**直接发首条消息 → 该会话语言为中文，Bash `description` 提示要求简体中文（回归防护：预热 createSession 漏带 language 会让整条链路退回英文默认文案）。
