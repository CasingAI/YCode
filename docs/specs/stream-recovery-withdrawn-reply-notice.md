# 断流恢复：黑名单策略与撤回提示

## 行为与所有权

- CLI Core 是模型流 recovery 的唯一决策者。无工具的 partial assistant 输出在普通 provider 错误下从既有安全锚点重试，预算最多 10 次；仅用户取消与已识别的上下文超限不进入通用 recovery。取消立即停止，上下文超限继续交给既有 reactive compact。
- 有工具时继续复用既有工具协调器：已经启动的工具等待真实结果并复用已提交锚点，尚未启动的工具只执行一次。被丢弃的 assistant tail 不进入模型历史。
- UI 提示来自现有 `timelineMarker` 投影，不创建第二份状态，也不加入模型历史。采用独立 `replyWithdrawn` marker；`retryNotice` 表达请求重试次数和原因，不适配撤回语义。
- marker 属于 `turnTailBoundary`，UI 渲染为弱于工具调用的一行纯文本：无标题、背景、边框或分隔线。文案为“模型撤回了一条未完成的回复”，同时提供英文翻译。

## 事件顺序与重放

```text
Core 判定错误（取消 / context exceeded 排除）
  → 现有 tail discard 关闭旧 assistant/tool 输入流
  → 同一权威事件投影出 replyWithdrawn timeline row
  → 既有锚点恢复与重试
  → event replay 与 transcript hydration 按 discarded assistant identity 去重
```

实时事件日志是权威状态源；transcript 冷恢复为旧日志/缺失事件提供兼容合成。marker 携带 discarded assistant message identity 作为幂等键，保证实时、刷新和冷恢复最多显示一次。提示只存在于 ConversationRow 投影，不合成 assistant/user/model message。

## 验收

- 不在黑名单的未知错误可进入无工具 recovery；预算最多 10 次。
- 取消立即停止；已识别上下文超限不进入通用 recovery，保持 reactive compact。
- 普通恢复不改变撤回 tail 的模型历史隔离；工具起跑/等待/锚点规则不变。
- 实时投影和冷恢复均只出现一个独立撤回提示；重复事件不会重复追加。
- 中文、英文文案存在；renderer 为单行纯文本样式，不使用 marker divider。
