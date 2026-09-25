# 手机 Web 有副作用操作的安全重试与结果对账

## 目标

解决“WebSocket 在按钮请求发出后立刻断开时，成功、失败和结果未知无法区分”的问题。第一阶段只恢复连接和读取；本规格定义第二阶段如何复用已有 V4 `commandId`/`CommandInbox`/`queryCommands` 机制，让可证明幂等的操作安全对账，让无法证明幂等的操作停在“结果未知”，而不是自动重发。

## 权威边界

- `commandId` 在同一用户意图的传输重试中保持不变。
- CLI `CommandInbox` 的 `sessionId + commandId` admission gate 和 `queryCommands` 是服务端权威；renderer 的 `PendingCommandRegistry` 只保存恢复线索。
- conversation snapshot 中的 queue/userInput/timeline marker `sourceCommandId` 是投影层权威证据。
- `queryCommands` 返回 `unknown` 不是“肯定未执行”，不能直接判定失败。
- transport reject 或 `ConnectionClosed` 只能说明客户端停止等待，不能证明服务端没有执行。

## 账本状态

现有 `PendingCommandRegistry` 扩展为以下恢复状态，不另建平行 store：

- 普通 pending：已在上行前记录，等待 ACK 或后续权威证据；
- `discarded`：服务端明确因 runtime restart 丢弃，允许用户确认后以新 commandId 重发；
- `unknown`：ACK 丢失、query 未命中或 query 暂不可用，禁止自动重发；
- accepted/duplicate：输入命令继续等待 projection `sourceCommandId`，非输入命令可结算。

`unknown` 必须保存原因（transport interrupted、query unknown 或 query unavailable）和最近一次对账时间，忽略提示不能删除待对账事实，直到明确收口或 TTL 到期。明确的服务端 `discarded` 事实优先于后续较弱的 `unknown` 查询结果，不能因一次未命中而丢失显式重发入口。敏感交互只保存 digest，不保存可重放答案。

## 对账顺序

1. 生成 commandId 后，在第一次上行前写入账本。
2. socket 断开时不重发；新连接且 conversation live 后按每批最多 64 个 key 查询当前 session 和 `sessionId: null` 的 createSession bucket。
3. accepted/duplicate 或 projection 出现 `sourceCommandId`：确认成功，不重发。
4. 明确 failed/rejected/stale：显示已知失败；discarded 仅允许用户显式重发。
5. unknown/query unavailable：显示“结果未知”，保留账本，等待下一次 live 连接或用户重新核对。

## 操作策略

| 操作类别          | 例子                                                                         | 断线后的策略                                                                         |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 读取/订阅         | session list、snapshot、rows、plans                                          | 新连接后自动重读/重订阅                                                              |
| durable V4 输入   | `sendText`、`sendGoalCommand`、`compact`、带 `firstInput` 的 `createSession` | 原 commandId 对账；accepted/duplicate 不重发；discarded 才能显式重发；unknown 不重发 |
| V4 控制/目标操作  | stop、pause/resume goal、queue 操作、模式切换、后台任务 cancel/resume        | 先 query 或读回；只有 handler 和事实存储明确保证时才允许同 ID 重试，否则 unknown     |
| 分支/文件/反馈    | fork、edit、file rewind、retry、feedback                                     | 没有完整权威事实就停在 unknown，不盲目重放                                           |
| 敏感交互/安全确认 | interaction answer、hook review/trust                                        | digest 只用于识别，不能自动代答或重放                                                |
| 非 V4 mutation    | 设置、文件/Git/终端、附件 begin/chunk/commit                                 | 无 operationId + query/read-back 就不自动重试；显示结果未知或按既有事务协议恢复      |

## UI 规则

扩展现有 `PendingCommandRecoveryBanner`：`discarded` 保留“重发”，`unknown` 只提供“重新核对/稍后”，不能显示自动重发成功。Banner 一次展示当前 pane 可见恢复集合中的第一项；“稍后”必须把该集合中所有当前可见的 `unknown`/`discarded` 恢复提示标记为 dismissed，避免多个同文案条目逐个补位造成“关不掉”。dismiss 只改变提示可见性，不删除账本事实；同一 recovery kind 的后续对账不能把 dismissed 条目重新写回，只有更强的 `discarded` 事实、明确收口或 TTL 才能改变其展示资格。无幂等保证的普通 RPC 使用统一的 `ConnectionClosed` 结果未知文案；明确发生在已销毁旧 client、尚未上送的请求则结算为“未发送”，不把异常当作成功。断线期在 facade 或 V4 握手阶段就被拒绝的调用属于“未发送”：这类错误带 renderer-local 的 not-sent 身份，账本直接结算，不得记为 `unknown`；`ConnectionClosed` 判定必须让位于 not-sent 判定，否则断线期会重新制造关不掉的提示。V4 初版写入的 legacy `unknown` 字符串线索只保留账本、不进入提示。计划批准静默拒绝在 Root 代际切换时复用同一 commandId。

V4 transport attachment 换代后，新的 live connection 对账必须先使用新 attachment 完成 V4 握手；握手失败只能保留 `unknown` 并等待下一次 live connection，不能把同一旧 attachment 的握手 Promise 当成新连接的成功凭据。

## 明确不做

- 不通过新 commandId 偷偷重发旧意图。
- 不把 query 未命中当作失败。
- 不自动重放设置、文件、终端、Git、附件或安全确认操作。
- 不新增与现有 pending command registry 并行的恢复系统。
- 不在没有 durable command fact 的情况下扩展 wire protocol；如盘点发现现有事实不足，先更新本规格再设计协议变更。
