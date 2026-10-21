# Spec: 工具入参校验失败的可读错误文本

## 目标

工具入参校验失败时，模型通道和 UI 拿到的是同一句可读文案，而不是内部 issue 的 JSON 序列化结果。

问题出在翻译层：`formatToolInputValidationError` 只翻译了四类 issue（缺参、多参、类型错、schema 自定义规则），其余 issue（`too_big` / `too_small` / `invalid_value` / `invalid_format` / `invalid_union`）没有对应分支，直接落进 JSON 兜底，被 `JSON.stringify(issues, null, 2)` 整段当成错误正文。

线上实例：TaskOutput 的 `timeout` 传值超过 300000 时，UI 的失败气泡里直接显示

```
[{ "origin": "number", "code": "too_big", "maximum": 300000, "inclusive": true, "path": ["timeout"], "message": "Too big: expected number to be ..." }]
```

用户读不出「哪个参数超了、上限是多少」，模型也读不出可据此修正的参数名，只能原样重试。

本 spec 规定工具入参校验失败的错误文本形态，要求所有已知 issue code 都必须翻译成人话。

## 产品规则

- **已知 issue code 一律翻译**：进入可读分支的 issue code 有 `invalid_type`（缺参 / 类型错）、`unrecognized_keys`、`custom`、`too_big`、`too_small`、`invalid_value`、`invalid_format`、`invalid_union`。任何一种都不得落到 JSON 兜底。
- **文本形态固定**：`<工具名> failed due to the following issue(s):\n<每条 issue 一行>`。多条时用 `issues`，单条时用 `issue`。
- **句式约定**（参数路径用反引号包裹，嵌套路径写成 `config.timeout`，数组下标写成 `items[0]`）：

  | issue code | 句式 | 示例 |
  | --- | --- | --- |
  | 缺参 | `The required parameter \`x\` is missing` | 保持现状 |
  | 多参 | `An unexpected parameter \`x\` was provided` | 保持现状 |
  | 类型错 | `The parameter \`x\` type is expected as \`string\` but provided as \`number\`` | 保持现状 |
  | 范围上界 | `The parameter \`x\` must be at most N` | `The parameter \`timeout\` must be at most 300000` |
  | 范围下界 | `The parameter \`x\` must be at least N` | `The parameter \`timeout\` must be at least 0` |
  | 范围独占 | `The parameter \`x\` must be exactly N` | 仅 `exact` 为真时使用 |
  | 取值枚举 | `The parameter \`x\` must be one of "a" \| "b"` | 单值时退化为 `must be "a"` |
  | 格式非法 | `The parameter \`x\` is invalid: <格式说明>` | `The parameter \`url\` is invalid: Invalid URL` |
  | 联合分支 | `The parameter \`x\` does not match any of the expected shapes:` 后跟各分支明细行 | 每个分支明细以 `- ` 前缀成行 |
  | 自定义规则 | 直接使用 schema 作者写的 message | 保持现状 |

- **范围文案带单位**：字符串上界/下界用 `characters`，数组用 `items`，数值不带单位。
- **落点在参数上**：范围、枚举、格式类 issue 的路径为空（作用在根值上）时，主语用 `The input` 而不是空反引号。
- **JSON 兜底只服务未知 code**：兜底分支仍然保留，字段插入顺序约束（见 `tool-input-validation-issues.ts` 顶部注释）继续有效。

## 接口

- `apps/zcode-cli/packages/core/src/tool/input-validation-model-content.ts`
  - `formatToolInputValidationError` 拆成「取文案行」与「拼头部」两步：新增内部纯函数 `formatValidationIssueLines(issues)` 负责逐条翻译，`formatToolInputValidationError` 只负责拼 `<工具名> failed due to the following issue(s):` 头部和最终兜底。
  - 新增内部纯函数：`formatSizeBoundIssue`、`formatInvalidValueIssue`、`formatInvalidFormatIssue`、`formatInvalidUnionIssue`、`formatValidationSubject`、`formatSizeBoundComparison`、`formatIssueValueText`。
  - 联合分支的明细复用 `formatValidationIssueLines` 递归翻译，不自己拼句子。
- 投影链路的其余部分（`projectInitialModelValidationIssues` 的 JSON / runtime 配对、`canonicalizeRuntimeOnlyIssue`）不改。

## 状态与时序

不新增状态。可读文本的唯一所有者仍是 `formatToolInputValidationError`；`projectInitialModelValidationContent` 把它同时交给 provider-visible 的 `<tool_use_error>` 包装和 `CoreError.message`，UI 侧的失败气泡、错误行、复制按钮都消费同一份文本，UI 不做二次解析。

## 负面边界

- **不改工具入参边界**：TaskOutput 的 `timeout` 仍然是 `[0, 300000]`，超限依然被拒（见 [`task-output-card.md`](./task-output-card.md)）。本次只改错误文案，不放宽也不收紧任何 schema。
- **不改 UI 渲染**：不在 `packages/ui` 侧新增识别 issue JSON 的分支；UI 继续只消费已经翻译好的文本。
- **不改 JSON 兜底的字段顺序**：兜底格式与字段顺序约束保持现状。
- **不改 `invalid_type` / `unrecognized_keys` / `custom` 的既有文案**：避免影响依赖现有句式的模型行为。

## 验收场景

1. TaskOutput 传 `timeout: 600000`：错误文本包含 `The parameter \`timeout\` must be at most 300000`，且不出现 `"code": "too_big"`。
2. 同一次调用既有类型错又有范围错：两类错误各占一行，都不是 JSON。
3. 字符串长度超限：文案为 `must be at most N characters`；数组元素超限：`must be at most N items`。
4. 枚举取值非法：文案列出全部候选值。
5. 未知 code（构造出的自定义 issue）：仍落到 JSON 兜底，字段顺序不变。
6. 既有回归不变：缺参文案、类型错文案、`custom` 文案与 Sandbox 二选一场景逐字不变。
7. `pnpm typecheck` 通过，改动文件 lint 干净，`@zcode/core` 相关单测全过。
