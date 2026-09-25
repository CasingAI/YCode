# Spec: 模型 Prompt 品牌称呼

## 目标

把运行时生成并呈现给模型的系统 Prompt、专用提醒、工具指引/描述和内置技能指引中的自然语言品牌称呼统一为字面量 `Y Code`。本次只改变模型可见文本，不迁移产品内部的 `zcode` 标识。

## 产品规则

- 主 Agent、专用连接探测、子代理、workflow、`/init` 和运行时提醒在模型可见文本中自称 `Y Code`。
- 工具 capability、provider description、model instructions、参数 schema description 和内置技能的实际指引使用 `Y Code`。
- 文本中的 `Y Code` 是展示名称；不得借此改写工具名、参数名、类型名、包名、协议字段、环境变量或 session ID 格式。
- Prompt 的 section 顺序、cache hint、注入目标、权限规则、只读边界、输出契约和事件顺序保持不变。
- 已经发送到当前会话的 Prompt 不会被原地改写；新建或重新构造的上下文才使用新文本。

## 状态所有者与接口

- `ContextBuilder` 继续是主 Agent system message 的唯一组装入口；CLI prefix、identity、desktop context 和动态 section 只提供文本，不新增状态。
- 各 `ToolEntry` 继续拥有自身 capability、metadata description、model instructions 和 schema 引用；本次不改变工具注册或调用路径。
- Skill loader 继续负责把技能描述和正文提供给模型；第三方归属声明不属于运行时品牌文本。
- 不新增跨包品牌状态、缓存、迁移队列或第二条 Prompt 组装路径。已有 prompt cache 在文本变化后按既有机制自然失效。

## 适用范围

### 模型 Prompt 与提醒

- 主 Agent CLI prefix、identity、Desktop Context。
- Explore/general-purpose 子代理和 workflow scheduler/expert prompt。
- 连接探测、跨会话消息、浏览器 ambient request、附件降级和 session reference reminder。
- 内置 `/init` prompt。

### 工具与技能文本

- Read、ReadSessionContext、Agent/Task、Plan Mode 等工具的模型可见描述和指引。
- 进入 provider schema 的参数 description。
- 内置技能中实际影响模型选择或执行的自然语言；第三方版权和 provenance 注释保持原样。

## 负面边界

本次明确不改：

- `@zcode/*`、目录名、文件名、TypeScript 类型、函数/变量名、工具名、协议名和协议字段。
- `ZCODE_*` 环境变量、provider ID、遥测值、HTTP User-Agent/header、进程/窗口识别规则和错误归因匹配字符串。
- Desktop/Web/UI/i18n、README、设计文档、启动画面和插件市场文案。
- `THIRD-PARTY-NOTICES.md`、许可证以及 `Modified by ZCode` 等第三方归属声明。
- 与模型可见文本无关的注释、日志和历史兼容数据。

禁止对仓库执行全局搜索替换；每个改动必须落在上述模型可见文本边界内。

## 验收场景

1. 默认配置构造主 Agent context 时，第一条 system prefix 为 `You are Y Code, an interactive coding agent`；identity 和 Desktop Context 正文不再出现独立的 `ZCode` 自称。
2. 启用 Output Style、Explore/general-purpose 子代理、workflow 和 `/init` 时，模型收到的角色说明使用 `Y Code`，原有安全、只读、输出和权限规则不变。
3. Read、ReadSessionContext、Agent/Task 和 Plan Mode 的 provider description、model instructions、schema description 使用 `Y Code`，但工具名、字段结构、返回值和权限判断不变。
4. 内置技能描述和正文中的模型指引使用 `Y Code`；第三方归属声明、协议名和内部标识仍保持原值。
5. 回归测试覆盖主要可导出的 Prompt builder、工具 metadata 和 schema 文本；类型检查、Lint、格式检查、架构检查和聚焦测试通过，基线失败另行报告。
