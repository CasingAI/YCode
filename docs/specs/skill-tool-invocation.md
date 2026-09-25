# Skill 工具调用边界

## 范围

本规范约束 Skill 工具从模型输入、运行时加载到共享聊天卡片展示的完整边界。目标是消除“Skill 支持参数”的错误能力预期，同时保留历史调用兼容和现有 `/skill <name> <task>` 行为。

不覆盖 Skill 发现与安装、Composer 的 Skill Picker、Skill 文件语法扩展、工作流参数或 MCP 工具参数。

## 产品规则

- Skill 工具的模型输入只有 `skill`：必须是当前会话可用列表中的精确名称，插件命名空间 Skill 使用完整的 `plugin:skill`。
- 用户任务始终属于用户消息或 prompt。`/skill <name> <task>` 中的 `task` 继续进入 prompt，由模型按已加载的 Skill 指令处理，不转换为 Skill 工具参数。
- Skill 工具只负责定位并加载对应 `SKILL.md`。加载器只接收名称、工作目录、大小限制和 trace 等加载上下文，不接收任务参数。
- Skill 正文不由工具参数改写。当前只允许展开 `${CLAUDE_SKILL_DIR}` 与 `${ZCODE_SKILL_DIR}`；不定义 `$ARGUMENTS`、`{{args}}` 或其他参数占位符。
- Skill 聊天卡片只投影 Skill 名称、运行状态、输出和失败信息。工具调用中的 `args`、`arg`、`path`、`prompt` 或 `input` 不得显示为 Skill 参数。

## 所有权

- `@zcode/contracts` 的 Skill 工具契约拥有模型可见输入形状。Provider schema 只声明 `skill`，不得声明或指导模型设置 `args`。
- Core 的 Skill handler 拥有加载行为。它只使用归一化后的 `skill` 调用 `SkillPort.loadSkill`，不消费兼容输入中的历史参数。
- Runtime input schema 只负责旧调用归一化。它可以把历史 `name` 转为 `skill`，并容忍旧 `args` 抵达 runtime gate；这种容忍不赋予参数执行语义。
- `packages/ui` 的 Skill renderer 是只读投影。它不得从原始 tool-call payload 猜测参数，也不得为历史字段创造新的产品含义。

## 兼容与失败语义

- 旧 `{ name, args }` 和 `{ skill, args }` 调用可以继续通过 runtime 归一化；handler 忽略 `args`，加载结果与不携带该字段时相同。
- Provider JSON Schema 不列出 `args`，但允许未声明的额外字段抵达 runtime 兼容门。未声明不等于 provider 向模型承诺该字段。
- 历史 session/tool-call 持久化数据不迁移、不重写。旧记录可以继续包含 `args`，新 renderer 必须安全忽略它。
- 兼容字段不是 Hook、插件或 Skill 的执行接口。任何依赖 `args` 改变 Skill 行为的逻辑都属于未定义行为，不得新增兜底分支。
- Skill 名称缺失、未知或加载失败继续沿用现有校验和错误语义；本次不新增参数相关错误。

## 不变量

- 模型收到的 Skill 工具 schema 和描述中均不存在 `args`。
- `SkillPort.loadSkill` 的请求形状和 `SKILL.md` 加载流程不变。
- 同一 Skill 名称在有无历史 `args` 时产生相同加载结果。
- 旧调用缺少有效名称时仍按现有规则失败，不因参数展示或兼容逻辑得到豁免。
- Desktop 与 Web 共用同一 Skill renderer，不能出现一端显示参数、另一端隐藏参数的语义分叉。

## 验收场景

- 新会话调用 `debug-mode`：模型工具 schema 只包含必填的 `skill`，工具说明不包含 `args`。
- 折叠 Skill 卡片：显示 Skill 名称和状态，不显示“参数”或输入摘要。
- 展开 Skill 卡片：显示加载结果，不显示参数行。
- 打开带历史 `args` 的调用：卡片正常渲染并隐藏该字段。
- 执行 `/skill debug-mode 排查某个问题`：任务文本进入 prompt，Skill 仍按名称加载。
- 旧 `{ name, args }` 与当前 `{ skill, args }` 均能归一化到同一个 Skill 名称，参数不影响加载结果。
