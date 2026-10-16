# 父 Guide 触发前台 Subagent 协作收口

## 目标

主会话接受 Guide 后，沿当前真实的前台等待关系请求子执行在安全边界协作收口，使父 turn 在完整工具批次持久化后消费 Guide。本功能不取消 child、不生成总结、不增加模型请求、暂停状态或用户操作入口。

## 状态所有者与边界

- CommandInbox 与父 runtime 输入状态唯一拥有 Guide admission 顺序、有效性及撤销事实；收口控制直接读取父输入 owner，不复制 accepted queue。
- 前台工具执行上下文持有只读 cooperative-yield 控制句柄，沿实际 Agent/Relay continuation 调用链传递；不建立第二套依赖注册表。`RuntimeTaskRegistry` 继续只拥有执行 generation 与生命周期投影。后台 Bash、历史任务和无关 Agent 不接收句柄。
- Subagent runner 拥有 child 生命周期、execution generation 和终态提交；child transcript/事件链路拥有已持久化消息、工具结果与终止事实；SessionStore 继续拥有稳定 `agentId`/`childSessionId` 身份。
- `execution completed` 仅表示本次 execution 收口，不代表原始任务已成功。`terminationReason: "parent_guide"` 是显式内部终止原因，不是取消或业务成功。

## 时序与竞态

```text
Guide admission → 父输入状态生效 → 本 turn/branch 的前台 execution 通过只读句柄观察有效来源
                                      ↓ 沿活动父子等待边递归传播
子模型步骤结束 → 完整接受工具批次执行并持久化/无工具步骤持久化 → 再核验 Guide 来源
      → generation/branch 匹配且仍有效：提交 parent_guide 终态 → runner 正常收尾、父工具返回
      → 来源已撤销且未提交收口：继续原执行
父工具完整批次持久化 → 父 FIFO Guide drain → 主 Agent 后续请求
```

- admission 后注册的 child 继承父输入 owner 当前仍有效的请求；不把 Guide 正文发送给 child。
- 多个 Guide 来源彼此独立。撤销只撤销该来源，且只影响尚未生效的收口；不 abort child。收口提交后撤销不恢复执行。
- 传播仅沿当前活动 join 边递归，隔离其他 Agent。登记、撤销、收口、迟到结果与清理都必须匹配 parent session/turn、branch 及 child execution generation；新 generation 不继承旧来源。
- 显式 Stop/Cancel 的真实取消优先于普通 Guide；真实异常仍为 failed。停止 hook、目标 continuation 不得在 parent_guide 后发起模型请求，但既有持久化记账仍需完成。

## 安全边界与结果

- 有工具步骤：等待模型流关闭、streaming coordinator 接受集合 drain、所有已接受调用执行并持久化、assistant/tool 消息闭合；即使一个 Agent 已请求收口，也等待同批其他 Agent 与普通工具。此后不启动下一模型步骤或业务工具批次。
- 无工具步骤：原正文、reasoning、usage、step-finish 持久化后核验请求。若自然终态先提交则保留自然结果；否则有效请求可提交 parent_guide。不得发总结或 continuation 模型请求。
- completed 输出 schema 可选携带 `terminationReason: "parent_guide"`；普通自然完成不携带，failed/cancelled 不携带。严格 schema、事件/协议透传和 formatter 同步更新，旧历史缺字段兼容。
- 提前收口仍返回真实稳定 `agentId`、`childSessionId`、`canContinue` 和已有用量，保留原 transcript/工具结果。Agent 与 RelayToSubagent 使用固定说明，明确原始任务完成未确认、历史可查询且可续跑；不能把中间正文包装成最终报告。
- 续跑使用同一逻辑身份与历史，分配新 generation，不重放已完成工具，不继承旧收口信号。

## 验收场景

1. Guide admission 立即触发当前前台依赖；流式 Agent 延迟注册后仍继承有效请求；无真实依赖时保持普通 Guide 行为。
2. 仅工具、无正文的 child 在步骤持久化后收口，模型调用数不增加；非空正文、reasoning、usage 与 step-finish 保留。
3. 模型流未结束时工具已启动，Guide 到达后同批所有已接受工具（含普通工具）最终结果均持久化；并行多个 child 时父级等完整批次再消费 Guide。
4. 嵌套 A→B 递归传播，活动等待边之外的 Agent 不受影响。
5. 唯一 Guide 在收口边界前撤销则 child 继续；多个来源只撤销一个仍收口；已提交收口不反向恢复。
6. 自然终态与 Guide 竞争按先提交者确定；真实失败仍 failed；显式 Stop/Cancel 优先。
7. Fork/Rewind、新 branch、新 execution generation 隔离；迟到结果和清理不污染新执行。
8. 提前收口之后 Stop hook/目标 continuation 不发新模型请求；完整保存统计、工具结果和终态事件。
9. Agent/Relay formatter 固定展示收口说明，不把中间文本包装为最终报告；续跑沿用身份/历史并创建新 generation，不重放工具。
10. 严格输出 schema、事件透传、旧历史 hydration、Desktop 连续流及 Web 可回放语义保持兼容。

## 不在范围

用户与 child 聊天、自动总结/HistoryRead/续跑、执行栈冻结、强制终止长耗时工具、后台任务收口与新的 UI/protocol 命令。
