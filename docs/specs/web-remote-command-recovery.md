# 手机 Web 有副作用操作的安全重试与结果对账

## 目标

解决“WebSocket 在按钮请求发出后立刻断开时，成功、失败和结果未知无法区分”的问题。第一阶段只恢复连接和读取；本规格定义第二阶段如何复用已有 V4 `commandId`/`CommandInbox`/`queryCommands` 机制，让可证明幂等的操作安全对账，让无法证明幂等的操作停在“结果未知”，而不是自动重发。

## 权威边界

- `commandId` 在同一用户意图的传输重试中保持不变。
- CLI `CommandInbox` 的 `sessionId + commandId` admission gate 和 `queryCommands` 是服务端权威。
- renderer 的 `PendingCommandRegistry` **不产生任何权威事实**，只保存恢复线索。它活在 localStorage 里，浏览器 origin 各自独立：桌面端窗口、Web、手机远控是三份互不可见的存储。命令号只存在发起端，因此非发起端**拿不到 commandId，连 `queryCommands` 都无从提问**。
- 时间线上每条用户输入的**唯一权威来源是服务端转录**。已受理且非排队的输入由 runtime 在会话变 live 的冷恢复（或回合逃逸、共享上下文降级路径）升格进转录；`session_input` 账本只作为升格/结算的记账与对账线索，不再作为气泡渲染来源。渲染层只消费服务端投影，没有第二条用户气泡来源。
- conversation snapshot 中的 queue/userInput/timeline marker `sourceCommandId` 是投影层权威证据。
- `queryCommands` 返回 `unknown` 不是“肯定未执行”，不能直接判定失败。
- transport reject 或 `ConnectionClosed` 只能说明客户端停止等待，不能证明服务端没有执行。

## 账本状态

现有 `PendingCommandRegistry` 扩展为以下恢复状态，不另建平行 store：

- 普通 pending：已在上行前记录，等待 ACK 或后续权威证据；
- `discarded`：服务端明确因 runtime restart 丢弃（仅主动排队与非用户发送种类），禁止重放，不进转录也不显示；
- `unknown`：ACK 丢失、query 未命中或 query 暂不可用，禁止重放；
- accepted/duplicate：输入命令继续等待 projection `sourceCommandId`，非输入命令可结算。

`unknown` 必须保存原因（transport interrupted、query unknown 或 query unavailable）和最近一次对账时间，直到明确收口或 TTL 到期——它标记的是「服务端无法证明未执行」，是禁止重放这条命令的依据，不是待展示的提示。明确的服务端 `discarded` 事实优先于后续较弱的 `unknown` 查询结果。敏感交互只保存 digest，不保存可重放答案。

## 对账顺序

1. 生成 commandId 后，在第一次上行前写入账本。
2. socket 断开时不重发；新连接且 conversation live 后按每批最多 64 个 key 查询当前 session 和 `sessionId: null` 的 createSession bucket。
3. accepted/duplicate 或 projection 出现 `sourceCommandId`：确认成功，不重发。
4. 明确 failed/rejected/stale：按已知失败收口；可补投的输入行在会话冷恢复时由 runtime 升格进转录，客户端不重放。查询期遇到仍处于「可补投已受理」的行按 unknown（结果未知、禁止重放）处理，等打开会话时由补投消费。
5. unknown/query unavailable：静默留存账本作为禁止重放标记，等待下一次 live 连接对账。

## 操作策略

| 操作类别          | 例子                                                                         | 断线后的策略                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 读取/订阅         | session list、snapshot、rows、plans                                          | 新连接后自动重读/重订阅                                                                                                         |
| durable V4 输入   | `sendText`、`sendGoalCommand`、`compact`、带 `firstInput` 的 `createSession` | 原 commandId 对账；accepted/duplicate 收口；已受理且非排队由 runtime 补投进转录（不重发、不开新回合），主动排队仍按重启清扫丢弃 |
| V4 控制/目标操作  | stop、pause/resume goal、queue 操作、模式切换、后台任务 cancel/resume        | 先 query 或读回；只有 handler 和事实存储明确保证时才允许同 ID 重试，否则 unknown                                                |
| 分支/文件/反馈    | fork、edit、file rewind、retry、feedback                                     | 没有完整权威事实就停在 unknown，不盲目重放                                                                                      |
| 敏感交互/安全确认 | interaction answer、hook review/trust                                        | digest 只用于识别，不能自动代答或重放                                                                                           |
| 非 V4 mutation    | 设置、文件/Git/终端、附件 begin/chunk/commit                                 | 无 operationId + query/read-back 就不自动重试；按既有事务协议恢复                                                               |

## UI 规则与读面不变量

**本规格不产生任何提示 UI。** 曾存在的 `PendingCommandRecoveryBanner` 及其「重发 / 重新核对 / 稍后」三按钮已删除。曾存在的「未送达伪行显示链」（`undeliveredInputs` 协议查询、renderer 侧负 `rowId` 插行、按 `createdAt` 插队渲染）也整条删除：补投让丢弃/失败输入真正进入服务端转录，投影里出现的就是权威用户气泡，不再需要客户端画假气泡。

**看见 = 模型下一轮能读到。** 读面渲染出的每条用户输入必须来自服务端转录投影。这一不变量由 runtime 的升格原语保证：已受理且非排队的输入在会话变 live 时补投进转录（与 user message/parts 同事务置 `promoted`），渲染层没有任何第二条用户气泡来源。`pendingCommandRegistry` 只保留「已送达命令禁止重放」的幂等语义，不再服务气泡展示。每条用户输入在模型上下文里也只有一份：live 回合的主路径先把正文放进内存历史再落库，落库失败由回合收口补投时只补库、不再灌内存，模型下一轮不会读到重复正文。

**补投不自动开回合。** 补投的消息按账本创建时间（`time.created`）落回它自己的历史位置——19 小时前丢的那条就该出现在 19 小时前那个节点，不堆到时间线末尾，也不伪装成刚发出的新消息。助手不会自动接着跑那一轮；用户想继续需要再发一条。

**历史捞取。** 历史上已显示成幽灵气泡的丢弃/失败行（`discarded/session_resumed`、`failed/turnLifecycleEscaped` 等逃逸原因）在该会话第一次冷恢复时捞进转录。入选条件与显示侧判据一致：

- 种类是用户发送（`sendText`，含建会话首条输入），有正文、能解析出命令号；
- 用户当时**没有主动选排队**（判 `requestedDelivery`，不判可能被降级改写的实际投递）；「自动」投递取保守值算进补投侧；
- 排除用户主动动作：`user_cleared`、`user_removed`、`cancelled` 是用户自己的裁决，不进转录；
- 排除主动排队、压缩、目标指令、后台唤醒、解析不出命令号的内部注入。

不另做迁移标记：升格成功后账本变为 `promoted`，下次冷恢复不会再捞；升格失败则下次打开再试。多条补投按账本创建时间升序，历史顺序与发送顺序一致。转录里已有相同命令号的用户消息时跳过写消息（避免双气泡），账本若仍非 `promoted` 只补账本状态。

**附件没了只留字。** 解析不到的附件不写进补投消息，正文照常进转录。

**共享上下文挂不上：字留下。** 发送不再报错、账本不结算失败；正文照常升格进转录；模型额外收到一条仅模型可见的说明（界面不画气泡）。共享上下文导入本身收口为丢弃。

**主动排队仍丢。** 用户当时选排队的，重启后不出现、不补投，账本仍是「重启不保留队列」；查询期排队已受理仍结算为重启丢弃，避免排队行永远占住串行入口。

`unknown` 完全静默，不渲染任何元素。操作类命令（stop、模式切换、后台任务 cancel/resume、分支、file rewind 等）的结果在对话流或状态位上本就可见，无需额外提示；敏感交互在等待确认态上可见，不确定时的实际结果由下一轮投影暴露。AI 无需在工具返回值里额外获知「结果不确定」——它重读文件、查任务状态即可自行确认。

账本的 recovery 状态**从「提示线索」退化为「已送达命令禁止重放」的内部幂等防线**：`unknown` 表示服务端无法证明未执行，必须留存至对账收口或 TTL 到期，防止将来某个重连场景重发已执行过的命令造成重复副作用。`dismissed` 概念随之移除。

`createSession` + `firstInput` 不做特殊排除：它在账本里的 `kind` 就是 `sendText`（`resolveInputCommandForAdmission` 归类），首条输入的记录挂在它创建出来的会话里（见 `create-session-command-fact.ts`），因此冷恢复补投按会话列举时对它同样成立，与普通消息走完全相同的路径。查询期它仍是已受理且可补投时表现为未知（不结算、不回失败），打开新会话时再补投。首条输入没有任何特殊语义，不存在「信息损失」。

判定规则（原「UI 规则」段保留部分）：

无幂等保证的普通 RPC 使用统一的 `ConnectionClosed` 结果未知；明确发生在已销毁旧 client、尚未上送的请求结算为“未发送”，不把异常当作成功。断线期在 facade 或 V4 握手阶段就被拒绝的调用属于“未发送”：这类错误带 renderer-local 的 not-sent 身份，账本直接结算，不得记为 `unknown`；`ConnectionClosed` 判定必须让位于 not-sent 判定，否则会长期留下禁止重放的死条目。V4 初版写入的 legacy `unknown` 字符串线索只保留账本。计划批准静默拒绝在 Root 代际切换时复用同一 commandId。

V4 transport attachment 换代后，新的 live connection 对账必须先使用新 attachment 完成 V4 握手；握手失败只能保留 `unknown` 并等待下一次 live connection，不能把同一旧 attachment 的握手 Promise 当成新连接的成功凭据。

## 发送期文本归属

点击发送到收到确认之间存在**真空期**：编辑器已清空、CLI 可能尚未落库，文本在全世界没有副本。这个窗口的归属规则如下。

**输入框可见文本保留到确认回来为止。** 发送按钮在该期间是 loading 态（`pending` + Spinner + 禁用），文本保持可见。这同时化解了「等确认再清空会让用户误以为快捷键未生效」的顾虑——转圈和残留文本就是快捷键生效的凭据。**可见编辑器的清空只允许有一个执行点**，且必须在确认路径上；点击发送时不得碰它。

**草稿在点击发送时就清空，且不得把在途正文写回草稿。** 草稿的语义是「还没发出去的文字」，在途文字不属于它。作用域恢复 effect 每次触发都会**无条件**把 `composerDraft` 灌回编辑器（`targetChanged` 只挡住落盘那半段，恢复那半段没有守卫），所以在途正文一旦写进草稿就会被一路灌回可见输入框；同时那次灌回会推进 `contentRevisionRef`，让收口处的「等待期间用户是否又敲了字」判定失配，结果是文本永远清不掉。

**清空时机从「点击发送」移到「确认回来」，只针对可见编辑器。** 成功才清编辑器；失败时它从未被动过，无需回填。草稿在两处清空：点击发送时清一次（让恢复 effect 灌回空值），确认时幂等再清一次。

**代价要说清楚：崩溃/刷新窗口内文本仍会丢。** 因为在途正文不能放草稿（见上），这个子目标没有达成。这与改动前一致，不是回退——要真正覆盖它需要一个与草稿语义分离的在途存储，属于独立改动。

**跨作用域竞态防护要收窄而不是删除。** 首发成功后作用域会从草稿作用域切到会话作用域，切换 effect 会先落旧作用域草稿再恢复新作用域——若在途正文被落进去，新 Composer 会把已发送的正文当草稿恢复。防护仍需要，但只作用于「在途时禁止跨作用域落盘」，不再全局禁止落盘。

## 明确不做

- 不通过新 commandId 偷偷重发旧意图。
- 不新增任何恢复提示 UI（横幅、toast、气泡角标），也不恢复「未送达伪行」读链。操作类结果本就可见；输入类丢失由 runtime 补投进转录，以服务端投影的普通用户气泡呈现。
- 不自动续跑未完成回合：补投只把消息放回历史，不触发模型接着跑那一轮。
- 不恢复用户主动清空/删除的输入：`user_cleared`、`user_removed`、`cancelled` 是用户自己的裁决。
- 子 runtime 直调恢复（fork/子会话内部路径）不覆盖本规则：主会话用户气泡不走那条路径。
- 不把 query 未命中当作失败。
- 不自动重放设置、文件、终端、Git、附件或安全确认操作。
- 不新增与现有 pending command registry 并行的恢复系统。
- 盘点结论：`session_input` 账本的 durable 事实**已足够**，不新增账本或写入侧字段。补投复用现有 `listSessionInputs` 端口与 `promoteSessionInput` 事务，升格/去重键全部取自账本载荷已有内容（`payload.conversationInputIntent.sourceCommandId`，旧格式 `payload.intent.sourceCommandId` 同取）。
- 跨设备补投**排除用户主动选排队的输入**（按 `requestedDelivery` 判）：重启丢弃排队消息是「重启不保留队列」这条明示裁决的兑现，补投它会让用户困惑（「我明明是自己选的排队」）。
- 「自动」投递取保守值算进补投侧（宁可多补一条），不按主动排队排除。
- 不改变「结果未知时用户手动重发可能重复执行」这一既有行为：今天的失败路径同样会把文本回填输入框，用户用新命令号重发同样可能重复。
