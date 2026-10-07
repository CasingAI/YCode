# Spec: 消息历史编辑（Message History Edit）

允许用户编辑**任意一条**历史 user 消息（当前仅允许最后一轮）。编辑采用**截断语义**：目标消息及其后的全部对话被逻辑剪除，编辑后的文本经「Undo + Send」两段式确认后原子执行。现有「仅末轮可编辑」的行为是本 spec 的真子集，末轮编辑体验保持不变。

## 背景

现状链路（已核对源码）：

- UI 入口：`packages/ui/src/v4/ConversationRowView.tsx` 行内编辑卡；入口可见性由 CLI 投影的 `row.actions.canEdit` 驱动（`SessionPane.tsx` 不做第二套 guard）。
- 投影层：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` 的 `materializeCommandRowActions` 只给倒序第一条 `realUser` 的 `userInput` 行打 `canEdit`；`currentEditableEntityId` 为单值权威，`resolveEditTargetByEntityId` 对非当前值直接拒绝。
- 命令层：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/fork-edit-retry.ts` 的 `editUserQuery`，非 latest 目标抛 `V4EditTargetNotLatestError`（`guard.latestQueryEditOnly`）。
- 重发参数：`startCanonicalIntent` 完整继承原 intent（mode、modelSelection、planEnabled、readOnlyEnabled、delivery、provenance），仅 text/attachments 可换；UI 以「冻结执行选择」徽标展示（`packages/ui/src/v4/conversationEditFrozenDisplay.ts`）。
- runtime：`apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts` 的 `rewindConversationToMessage` **已支持锚定任意历史 user prompt**（含 compact 边界之前）做 append-only branch cut；`setRevert` 写 `keptMessageIDs` + `branchGeneration`，消息不物理删除，active branch 由过滤元数据决定。
- 文件回滚：编辑提交经确认弹窗提供「含文件恢复」（`workspaceMode=rewind`）/「不动文件」（`preserve`）双动作（规则 40），preview + fail-closed（unsafe/ignored 文件直接 blocked），文件还原与对话截断在同一 commit gate 原子执行；冲突经 `packages/ui/src/v4/ConversationFileRewindDialog.tsx` 呈现。
- 多轮级联回滚原语已存在：`selectCheckpointsForMessages`（按消息集合取 checkpoint）、`activeSuffixMessageIdsForRewind`（目标起的整个后缀）、`rewindWorkspaceToCheckpoints`（多 checkpoint 先全读后倒序恢复）。

## 产品规则

### 截断语义

1. 编辑第 N 轮的 user 消息 = 将第 N 轮（含其旧文本）及其后**所有轮**从 active branch 剪除，随后以编辑后文本在第 N 轮位置重发新 turn。
2. 被剪除的消息为逻辑剪除：存储层保留（append-only），但 UI 时间线、模型上下文、冷恢复、移动端回放均不可见，且**不提供任何恢复入口**。文案一律按「不可恢复」表述，不向用户承诺数据可找回。
3. 被剪除轮次的 AI 回复随轮一并剪除；后续轮中**用户自己的提问同样被剪除**，属本功能最敏感的删除对象，是确认弹窗存在的主要理由。
4. 编辑目标必须是 `origin === "realUser"` 的 `userInput` 行；synthetic/system 来源行不提供编辑入口。
5. **引导内联行的 live 裁剪起点**（2026-10-06 增补，真机 bug 修复）：guide steer（`delivery=guide`）行由投影 `onTurnSteerDrained` 内联进原任务 product turn（仅 `queue` 交付才 `splitProductTurn` 切段）。以引导行为目标的 edit/retry，其 runtime rewind 锚点是引导消息本身（`keptMessageIDs` 保留同轮前缀），因此 live 投影 `onRewindTriggered` 的 `row.removed` 起点必须是**引导行自身 rowId**，不得回溯到所属轮的 turnHeader——否则同轮前序行（原始任务消息气泡及此前的回复）会从时间线被误删，与持久化 active branch 及冷恢复重建结果不一致（表现为「编辑引导消息后前面那条消息不见了」，刷新后复活）。queue 交付行已切段为新轮首行，维持从新轮 turnHeader 起删的既有语义。

### 参数解冻

5. 编辑卡内该轮的执行参数（mode、modelSelection、planEnabled、readOnlyEnabled）**缺省显示该轮当年的原值**，但改为可修改的控件（不再只读徽标）。
6. 用户未显式修改的参数沿用原值；显式修改的参数以修改值随重发提交。
7. 协议层命令 payload 以**可选字段**承载参数覆盖；旧客户端不发新字段时，CLI 缺省行为与现状一致（完整继承原 intent），保持向后兼容。
8. intent 的 delivery、provenance、queueItemId 等命令内部字段**保持继承、不开放编辑**。**kind 不再继承**（2026-10-07 修订，取代「kind 保持继承」原口径——该口径曾导致普通消息编辑成 `/goal …` 只被当普通文本重发、目标静默不生效，即 sess_5bb5f042 事故）：重发命令身份按编辑后新文本的 goal token 重判（`hasGoalCommandToken`，唯一真源 `@zcode/shared` goal-command-token.ts）——普通消息编辑成 `/goal …` 即真实落目标，goal 行删掉 token 即回归普通重发；`retryTurn` 不重判，沿用旧行 kind（重试不改文本）。判定结果同时驱动 goal 门禁与 canonical intent 重建（审计日志记重判后的 kind），并经投影写入行 `commandKind` 下发——气泡 goal 芯片读该字段（见 `goal-command-scope-and-decoration.md`「回显边界」），编辑成 goal 的行回显即权威。**重发落库的可见文本必须含命令 token**（2026-10-07 增补）：编辑成 goal 的重发把编辑原文（`payload.newText`）作为 `displayText` 传入落库（原文保真，含前文与原大小写）；`retryTurn` 的 goal 行重发与旧行 `intent.text`（纯 objective）一样依赖落库单点构造 `` `/goal <objective>` ``。只重判身份不落 token 曾导致「目标设置成功、气泡却画不出芯片与染色」——契约全文见 `goal-command-scope-and-decoration.md`「落库形态」。
9. **编辑成 /goal 与发送同源门禁**（2026-10-07 增补）：编辑文本含 goal token 时，`editUserQuery` 在**rewind 与文件回滚之前**按发送路径同一套门禁裁决，顺序固定：附件 → 档位 → 空目标。
   - 带附件 → `guard.goalAttachmentsBlocked`；
   - 提交档位为受限档 → `guard.planGoalMutuallyExclusive` / `guard.readOnlyGoalMutuallyExclusive`。档位解析与发送同源（`resolveSubmittedExecutionState`：payload.mode 优先，缺省回落会话当前档，协议直连 fail-closed）；
   - token 后无目标正文 → `emptyObjective`。
     拒绝时经 `cancelInputCommand` 取消队列项，以 `editUserQuery { disposition: "blocked", reasonCode }` 返回，编辑卡保持打开、行内展示原因（空目标键 `chat.edit.goalEmptyObjective`，其余复用 `chat.goal.*` 文案），**不发生任何截断、不写目标、不改档位**。通过时：目标正文取 token 之后的解析结果（`parseGoalObjectiveFromCommandText`，strip "replace " 前缀），`applyGoalCommand` 以 `delivery: "immediate"` 执行（落档 → setTarget → 续跑，落档档位即门禁解析出的同一档位——缺 delivery 会让受限判定读会话旧档、在 rewind 之后才拒绝，违反本条拒绝前置）。UI 侧：编辑卡在受限档下从斜杠面板排除 goal/target（与主 composer 同规则），但发送按钮保持可点，反馈一律走提交时门禁（不灰按钮——禁用态拿不到 hover/touch 事件，Web/手机端无处可见原因）。

### 编辑卡附件

41. **编辑卡支持新增/删除附件**（2026-10-10 增补）：编辑卡除删除该轮原附件外，提供与主 composer 同源的新增附件入口（文件选择器、粘贴、外部文件拖放），复用 `useComposerAttachments` 行级实例（scope=`edit:<rowId>`，与主 composer 草稿 scope 隔离；不消费 add-to-chat 事件，不覆盖 E2E scope owner——`exposeE2EScopeKey: false`）。语义：
    - 上传依赖（`attachmentSessionId`/`attachmentPut`/runtime 生命周期）由宿主经 `ConversationRowRenderContext.editCardAttachments` 注入，编辑目标行所在会话即上传目标会话；注入缺席时编辑卡退回现状（只能删除原附件）。
    - 新增件上限与发送一致：`MAX_CHAT_ATTACHMENTS` 按「原附件 + 新增」合计（行级实例以 `reservedSlotCount` 承载原附件占额）。
    - 提交时经 `prepareForSend()` 把新增件转成 `AttachmentRef[]`，与保留的原附件合并为**完整列表**提交——保持「省略空数组=恢复 canonical 原附件、显式 [] 才表示删除全部」的既有协议语义；有未就绪上传时发送被阻塞（发送键禁用 + 提交入口二次门禁）。
    - 提交成功后新增件移交会话（adopt）并清空行级 scope；编辑卡任何关闭路径（取消/失焦/被顶掉/虚拟化卸载）丢弃未提交的新增件——规则 39 的停靠仍只覆盖文本，附件不进停靠。
    - 编辑成 `/goal` 的附件门禁（规则 9）按合并后的完整附件列表在 CLI 侧生效，UI 不做预检。

### 文件回滚

9. 默认 `workspaceMode=preserve`：被剪除轮次写下的文件改动保留在工作区（与现状末轮编辑 preserve 语义一致；接受「对话无记录但文件存在」的不一致）。
10. 「对话 + 文件重置」选项对中间编辑**保持可用**：预览范围从「该轮 checkpoint」扩展为「编辑点之后全部 active 轮的 checkpoint 级联」，UI 展示将还原的文件清单（文件 + 还原到哪一轮之前）。
11. 检测到无法安全回滚（unsafe/ignored 文件、checkpoint 缺失/不可读）时沿用 fail-closed：选项置灰给出原因，或提交时 blocked 返回原因码；冲突弹窗复用 `ConversationFileRewindDialog`（含「仅重置对话并发送」逃生口）。
12. 文件还原与对话截断保持同一 commit gate 原子执行；沿用现有直驱 primitive 的方式（见 `fork-edit-retry.ts` 头注中组合 rewind 死锁的历史教训），不得在 file transaction callback 中排队命令。

### fork 与 compact-edit 的继承边界

31. 稳定 fork（`forkStableConversationAtMessage`）与编辑历史产生的 compact-edit 子会话（`forkConversationBeforeMessage`）继承**被复制历史范围内**的 workspace checkpoint 条目（重映射后），文件回滚能力与父会话一致。两者同走 `commitAtomicConversationFork`、都是 fork 语义——写死为规格，避免日后被当成实现副作用改掉。
32. `selection_side_chat` 副屏不继承 checkpoint 与 file-rewind 条目。
33. 继承的 checkpoint 产物仍引用父会话存储（artifact URI 内嵌父会话 id），不物理复制；父 artifact 被清理时子会话 checkpoint 按既有 fail-closed 退化为 unsafe，不误删文件。artifact 物理复制记为后续增强。
34. workspace file-rewind（已撤销，`reason=file_summary_rewind`）条目**一并继承**：不继承会让子会话对已撤销文件重复亮起可重置（磁盘已是撤后状态），属假 affordance。该类条目**必须带目标消息身份（`targetMessageId`）才继承**——缺目标消息身份时投影无法把它标成已撤销，带进子会话只是死条目。
35. **身份重生成**：`session_entry.id` 是全库主键、写入是 on-conflict 更新（守卫注释见 `sqlite-session-store.ts:527-531`），沿用父 id 会把父条目改绑到子会话。两类条目的条目身份与事件身份都重生成：`workspace-checkpoint:<新事件id>` / `workspace-file-rewind:<新 rewindId>`，payload 的 `rewindId` 同步重生成——恢复去重用**重生成后的值**在子会话内比对。
36. **映射、保留与过滤**：payload 内消息身份（`messageId` / `targetMessageId` / `toolMessageId`）走 fork 消息映射；条目外壳 `turnId` 走 turn 映射，**无映射时删除该字段而不是丢弃整条**；`checkpointId` / `snapshotRef` / `diffRef` / `targetCheckpointId` / `restoredSnapshotRef` 保持父值，子会话继续指向父产物。主身份（`messageId` / `targetMessageId`）无映射时丢弃整条并 warn。只继承 `scope ∈ {workspace, both}` 的 checkpoint（conversation scope 不继承），且目标消息身份必须命中被复制历史。序号与时间沿用父值、不重编号——恢复路径本就复用它们排序，且子会话 resume 时事件库为空、先灌条目再追加 SessionResumed。
37. **编辑提交被拒不静默**：`editUserQuery` ack 被拒（如 `proto.staleRevision`、目标失效等）时，编辑卡保持打开并显示行内错误提示（zh「发送未生效：会话内容已更新，请重试」，键 `chat.edit.submitRejected`）；dispatch 抛错（连接未就绪/中断）同样提示，文案键 `chat.edit.submitRejectedConnection`（zh「发送未送达：连接已中断，请重试」）。再次提交或重开编辑卡即清除；正常提交与提交后 blocked 兜底弹窗（规则 26/28）不受影响。预览失败仍按规则 23 降级纯对话弹窗。**边界**：命令已发出但 ack 永不返回的传输层挂起不属于本规则，需传输层补齐，不得用超时兜底。（2026-10-06 调查结论：此前观测到的「renderer 重载后首条命令 ack 永不返回」经 CDP 受控复现证伪——reload 后 2 秒内以受信任点击提交末轮编辑，ack 1.1s 正常返回，CLI 正常落 `completed` 日志；原始观测系测试脚本用 `el.click()` 非受信任点击未触发 React 表单提交所致（`submitting` 从未置位、CLI 从未收到命令），非产品 bug。renderer 重载确有轻微残留：宿主侧 `zcode:settings-changed` 监听器跨重载累积（MaxListenersExceededWarning），与 ack 无关，另行处理。）
38. **编辑卡失焦退出 + 全局单卡**（2026-10-06 增补）：

- **互斥**：同时至多存在一张打开的编辑卡。开合通知 `onEditCardOpenChange(rowId, open)` 由行上报，宿主 SessionPane 的 `editingRowId` 是唯一所有者；close 携带 rowId 做 owner 感知（只清仍指向自己的 state），避免后开卡被先关卡的延迟通知误清。其余编辑卡消费 `editingRowId` 互斥自行退出，行间不直接通信。
- **失焦退出**：编辑态下 `pointerdown` 落在编辑卡行容器（`[data-row-id]`）以外即退出编辑（等同取消）。挂在 body 直下的 Radix portal 内容（模型选择、tooltip、确认弹窗）不算失焦；`submitting` 期间不退出。
- **工具条热键让位**：编辑卡打开时主 composer 的 Ctrl+M / Ctrl+Shift+M / Ctrl+T 整体下线（`useToolbarShortcutBindings` 的 `suppressed`，由 SessionPane 经 `editCardHotkeysSuppressed` 下发），同键位由编辑卡内同款控件注册的监听接管——否则先注册的主 composer 监听先赢，热键仍作用于主 composer。

39. **半编辑草稿停靠**（2026-10-06 增补）：编辑卡因失焦、被其他卡顶掉或行虚拟化卸载而**被动关闭**时，未提交的文本草稿不停留在原地丢失，而是停靠到宿主（SessionPane，key=`sessionId:rowId`，存 ref Map 不参与渲染）；再次打开**同一条消息**的编辑卡时恢复停靠草稿。恢复带 base 校验：仅当停靠时的原文（打开卡时的 `visibleContent`）与当前行原文一致才恢复——提交成功后行原文已变，停靠条目自然失效。**显式取消**与**提交成功**仍是丢弃语义：清除停靠并复位卡片状态。停靠/恢复只覆盖文本草稿（附件、mode、modelSelection 维持既有开卡复位行为）；宿主不提供停靠接口时行为回退为现状（开卡复位）。
40. **唯一提交入口**（2026-10-06 修订，取代同日早先的同号「粗判包含自身轮」口径——该粗判信号随按钮一并移除，未随任何版本发布）：编辑卡工具条**不再有**「与文件一起重置」独立按钮（`FileClock` 图标 + 状态式 tooltip 的可供性被真机自测证伪：看起来像开关，实为平级的第二个提交动作，且紧邻 ✕/↑ 存在误触面）。↑ 是**唯一**提交动作，**所有编辑提交一律先弹确认窗**：纯对话（规则 24）/ 文件清单双动作（规则 25）/ 冲突（规则 26）三形态，末轮不直发、无文件末轮弹纯对话窗。弹窗文件清单以提交前 `fileRewindPreview` 为准，`actions.editFileRewindFiles` 粗判、TurnGroup 可用性判定与 `resetConversationAndFiles.*` i18n 全部下线。

### UI 与交互（Undo + Send）

13. 打开非末轮消息的编辑卡时，`rowId` 在编辑目标之后的**所有时间线行实时弱化**（`opacity-40` + 禁交互，行级收口在 `ConversationRowView` 分发层），直观呈现删除范围；关闭编辑卡即恢复。（2026-10-06 修订：弱化从 Timeline 轮级下沉到行级——轮级盖不住编辑轮自身的回复行，且两层叠加会把后续轮压到 0.16。）
14. 编辑卡内**不显示**将被删除的轮数提示（曾有的内嵌黄条已按用户决定移除，2026-10-06）；删除后果只由时间线弱化（规则 13）与提交确认弹窗（规则 15）承载。编辑卡内模型选择器 trigger 恒为图标态（`forceCompactModelTrigger`）：编辑卡窄于主 composer，provider/model 文本标签隐藏以省横向空间。
15. 编辑提交的动作为 **Undo + Send**（2026-10-06 修订：**所有编辑统一**，含末轮）：点击 ↑ 提交 → 确认弹窗 → 确认后 Undo（截断）与 Send（重发）**连续原子执行**，不提供「只 Undo 不 Send」的中间态。中间轮文案「将删除此消息之后的 N 轮对话，不可恢复」；末轮无截断轮，文案改述「重发将丢弃这条消息当前的回复并重新生成」。
16. 弹窗确认前，完整时间线（含弱化预览）仍在视野内，此为唯一的反悔窗口；确认后不再有二级反悔。
17. 文案（i18n）：动作与确认按钮使用「Undo + Send」表述（zh-CN：「撤销并重发」；具体键名实现时定，沿用 `chat.edit.*` 命名空间）。
18. **编辑卡预填形态**（2026-10-07 增补）：开卡回填时命令 token 的呈现权威是行 `commandKind`，与气泡同一判定源——`sendGoalCommand` 行把首个 goal/target token 还原成命令芯片（id `prefill-slash:<命令名>`，图标与面板选中同源；芯片 `markdown` 存原始 token 切片，整框 getMarkdown 与原文逐字一致，提交重判链不受影响，整框最多一枚），正文照常染色；`sendText` 行与旧 snapshot 维持纯文本回填 + 文本匹配染色（编辑器是草稿面，染色表达「提交后将成为什么」）。细目见 `goal-command-scope-and-decoration.md`「编辑卡预填形态」。

### 提交确认弹窗的三态（2026-10-05 增补，竞品对照结论）

参照 Cursor（提交前 checkpoint 校验 + 弹窗平级选项）与 Claude Code（文件/对话独立选择）的设计，确认弹窗按文件回滚 preview 结果分三态；「仅重置对话」从失败降级升为弹窗平级选项：

23. 提交前必须先取文件回滚 preview（`v4/conversation/fileRewindPreview`，目标为编辑行，范围=编辑点之后全部消息）；preview 失败时降级为现行为（提交后命令层 preview 裁决）。
24. **无文件态**：preview 范围内无任何涉及文件（safe/unsafe/ignored 均空）→ 弹窗只讲对话截断（现有 `chat.edit.undoConfirm.description`），不出现任何文件语义。
25. **可回滚态**：范围内有 safe 文件且无 unsafe/ignored → 弹窗列出文件还原清单（restore/delete 逐文件），提供平级双动作：「撤销并重发（含文件恢复）」（`workspaceMode=rewind`）与「撤销并重发（不动文件）」（`workspaceMode=preserve`）。
26. **冲突态**：范围内含 unsafe/ignored 文件 → 弹窗说明冲突原因并列出冲突文件（复用 `ConversationFileRewindDialog` 渲染），选项：「仅重置对话并发送」（preserve）；当全部 unsafe 均为 `external_modified` 时额外提供「仍然恢复文件并重发」（rewind + `fileRewindConflict=overwrite`）。
27. **保留清单口径**：弹窗中列出的文件并集（safe+unsafe+ignored）即「本次编辑将恢复或保留的全部文件」；被剪除轮次产生的文件在「不动文件」动作下全部保留。范围外孤儿文件（更早被剪除轮留下）不在本清单内，属既有知情范围。
28. **blocked 收窄**：`guard.workspaceRewindUnavailable`（safeFiles=0）不再视为失败——无文件可恢复直接按纯对话编辑执行；blocked 仅保留给提交时状态突变（apply 竞态失败、提交前后 preview 不一致），UI 以冲突弹窗兜底呈现。
29. **覆盖快照（安全网定位，2026-10-06 修订）**：`fileRewindConflict=overwrite` 时，apply 前必须把「当前磁盘状态」持久化为 workspace checkpoint（anchor=编辑目标轮 user messageId）；`checkpoint_missing/unsupported/unreadable` 类 unsafe 不可覆盖（恢复数据不存在，覆盖无意义）。边界：编辑会截断重发并移除锚点消息，因此该快照不会被后续 rewind 范围命中，仅作防丢数据的持久化安全网（用户决定不做重锚，接受 UI 不可达）。
30. **编辑卡 reasoning level**：modelSelection 覆盖支持 `options.reasoningLevel`（schema 已有）；编辑卡内更换 provider/model 时按目标模型 capability 重置档位（复用 composer reasoning 选择器与数据源），缺省继承该轮当年 admission 值。

### 运行中与并发

18. 编辑目标轮之后存在 running turn 时，沿用现有 `preemptActiveTurnAndWait` 停止后再截断。**内部抢占语义修订（2026-10-07 增补，真机 bug 修复）**：
   - **内部抢占 ≠ 用户 Stop**：`editUserQuery` 的抢占必须传 `preserveQueueAutoDrainOnCancel: true`（与 `sendText` 立即发送 `session-flow.ts`、`sendQueuedNow` `queue.ts` 同源），被中止 turn 按 cancelled 收口时**不得**翻转 `queue.autoDrain` / 写入 `pauseReason:"stopped"`——否则重发输入一旦因 busy 尾巴入队，就会与「由于你中断了当前响应，队列已暂停」横幅叠加成需要用户手动恢复的死队列。
   - **重发必须直接启动，不得落队**：抢占后的重发输入以 promotion lease（`acquireForegroundPromotionLease`，leaseId 形如 `edit-resend:<commandId>`，mode `after-current`）占住空闲位，`startPromptTurn` 带 `requireIdle: true`（sendText 立即发送同款）；lease 冲突在 rewind **之前**以 `V4InputAdmissionRejectedError` 拒绝，不留半程状态。配合此语义，`waitForSessionIdle` 的 idle 轮询必须覆盖 Core `hasActiveOrQueuedTurnWork()` 的全部 busy 信号（drain 活动、命令队列、activeTurn、reservation），仅排除编辑自身持有的 lease——只轮询 `activeAbortController` + `activeForegroundExecutionId` 会在旧 turn 收尾窗口误判 idle，把重发输入推进队列。
   - **goal 语义与 send-now 一致**：抢占时 goal 照旧置 paused（`edit_user_query_goal_paused` 同源），不新增自动恢复；普通文本重发轮照常运行。
   - **静态编辑路径不变**：无运行中 turn（无 `activeAbortController` 且无 Core 前台执行）的编辑不取 lease、不抢占，行为与既有语义完全一致。
19. 队列中已 admit 的输入所属轮被剪除时，按现有 admission 语义清理/取消，不悬挂。
20. `guard.latestQueryEditOnly` 错误码保留，语义收窄为**并发竞态防护**（提交时目标已不是可编辑目标，如另一端已发送新消息或已完成编辑），正常路径不再触发。

### compact 交互

21. compact 边界之前的消息**允许编辑**（runtime 已支持）；provider 上下文中该段已被摘要替代，branch cut 后的上下文重建正确性列入重点验收场景。
22. compact 进行中（`compactActive`）时编辑入口保持现状：不可用。

## 状态所有权与接口边界

```text
用户点击编辑 → ConversationRowView 编辑卡（renderer 本地 draft：文本/附件/参数覆盖）
  → SessionPane dispatchCommand("editUserQuery", payload)
  → v4 命令层：resolveRowActionTarget（投影权威校验）→ 非空校验
  → 命令身份按新文本重判（规则 8）；goal 编辑走同源门禁（规则 42，拒绝前置）
  → [workspaceMode=rewind] preview 多轮 checkpoint → fail-closed 或继续
  → preemptActiveTurnAndWait（如 running；带 preserveQueueAutoDrainOnCancel，见规则 18）
  → runtime.rewindConversationToMessage（branch cut，setRevert）   ← Undo
  → startPromptTurn（普通文本，requireIdle 占空闲位）/ applyGoalCommand（goal，delivery=immediate） ← Send
  → RewindTriggered 事件 → 投影重算 actions → UI 时间线更新
```

- 可编辑目标与 actions 的唯一权威仍是 CLI 投影（`product-projection.ts`）：放开后从单值 `currentEditableEntityId` 变为「全部可解析 editTarget 的 realUser 行」集合；UI 与命令 resolver 共用同一次 materialization 的结果，handler/preview 不重算。
- 编辑卡 draft 是 renderer 本地状态，不构成第二条 accepted queue；提交后以命令 envelope + revision 走现有乐观并发。
- 协议改动同步 `packages/shared/src/zcode-protocol-v4`（CommandPayloadMap、rows actions），严格类型 + 运行时校验；桌面 `desktop-continuous` 与手机 `web-remote-replayable` 两条链路同时验证（截断后的恢复/回放语义）。
- `revert` 元数据结构（单前缀 + branchGeneration）保持不变；本 spec 不引入多分支。
- checkpoint / file-rewind 条目的唯一所有者仍是 runtime 持久化层（父会话写、子会话 fork 时按规则 31-36 复制）；CLI 投影与 UI 不新增状态，只消费既有条目恢复出的事件。

## 验收场景

1. **末轮编辑**：编辑最后一轮消息 → 弹确认窗（无文件：纯对话形态，文案为末轮变体；有文件：文件清单双动作）；确认后回复被丢弃并按新文本重新生成。（2026-10-06 修订：末轮不再直发，统一走弹窗，规则 40。）
2. **中间编辑基本流**：编辑 5 轮会话的第 2 轮 → 第 3-5 轮实时弱化；提交弹窗显示「将删除 3 轮对话」；确认后第 3-5 轮从时间线消失，第 2 轮显示新文本并重新回答。
3. **弹窗取消**：确认弹窗点取消 → 无任何截断发生，编辑卡保持打开，弱化恢复。
4. **参数缺省与覆盖**：打开第 2 轮编辑卡，mode/model 显示当年值；不改直接提交 → 重发沿用当年值；改为最新模型提交 → 新 turn 按新模型执行。
5. **文件回滚多轮**：第 2-4 轮各改过文件，编辑第 2 轮并勾选「对话 + 文件重置」→ 预览列出第 2-4 轮全部文件还原清单；确认后文件恢复到第 2 轮之前状态，与截断原子完成。
6. **文件回滚 fail-closed**：预览含 ignored/unsafe 文件 → 选项置灰或提交 blocked，弹窗说明原因，「仅重置对话并发送」可用。
7. **运行中抢占**：第 5 轮 running 时编辑第 2 轮 → 当前 turn 被停止，随后截断 + 重发。
8. **并发竞态**：编辑卡打开期间另一端发送新消息 → 提交被拒，`guard.latestQueryEditOnly`（或等价 reasonCode）呈现，无截断发生。
9. **compact 前编辑**：会话发生 compact 后，编辑 compact 边界之前的消息 → 截断与重发成功，重发后模型上下文正确（不包含被剪除段、摘要边界处理正确）。
10. **冷恢复与远程**：中间编辑后重启会话/手机端接入 → 时间线与 active branch 一致，被剪除轮不出现。
11. **只读/分享视图**：`readOnly`、selection side chat、分享只读时间线不出现编辑入口（回归）。
12. **无文件编辑**：编辑一条其后无文件改动的消息（中间或末轮）→ 弹窗只讲对话截断/重发，不出现任何文件语义，「文件无法安全重置」不再出现（规则 28：不再 blocked）。
13. **弹窗双动作**：编辑其后有安全文件回滚的中间消息 → 弹窗列文件清单；选「含文件恢复」文件被还原，选「不动文件」文件保留、对话仍截断。
14. **外部修改覆盖**：编辑点之后文件被外部修改 → 冲突弹窗列出冲突文件；「仍然恢复文件并重发」执行后文件恢复、且覆盖前快照已持久化（定位见规则 29：安全网，UI 不提供找回入口）；含非 external_modified 冲突时该选项不出现。
15. **换模型 reasoning**：编辑卡换到需要 reasoning level 的模型（如 GLM-5.3-Flash）→ 档位控件按目标模型重置，重发成功，不再出现「Reasoning level is required」失败中间态。
16. **fork 继承**：父会话写过文件后 fork → 子会话对应轮编辑提交时 preview 文件清单正确，「不动文件」与「含文件恢复」两个动作都能跑通。
17. **fork 已撤销状态**：父会话里已经做过文件回滚的轮次 → 子会话显示已撤销状态，不再当可重置亮起。
18. **运行中编辑直接重跑**（规则 18 修订）：流式输出中编辑当前轮（或其后有 running 轮的）消息并发送 → 输出停止、历史截断、编辑后的输入**立即重新开跑**；全程无排队项出现、无「队列已暂停」横幅、无需手动再点发送。
19. **运行中编辑不影响既有队列**：队列里已有排队项时运行中编辑重发 → 排队项保留且队列不被置成 stopped 暂停（autoDrain 保持），重发轮直接启动，队列项随后按 FIFO 继续。
20. **静态编辑回归**：无运行中 turn 的会话编辑提交 → 行为与修订前一致（不取 lease、不抢占、直接 rewind + 重发）。
18. **副屏回归**：副屏会话仍然没有任何文件回滚入口。
19. **compact-edit 继承边界**：编辑历史产生的子会话只继承编辑点之前被复制的那一段历史的 checkpoint；编辑点之后的轮不产生继承条目。
20. **编辑成 /goal 生效**（规则 8/42）：Agent 档下把普通消息编辑成 `/goal 修复登录` 提交 → 该轮截断、目标落为「修复登录」（不含 token）、自主续跑启动，行为与直接发送 /goal 一致。
21. **编辑成 /goal 被拒**（规则 42）：Plan/Ask 档或带附件或裸 `/goal` 提交 → 编辑卡保持打开并行内展示原因，历史不截断、目标不变；随后取消编辑，原对话完整。
22. **goal 行编辑回归**：goal 行删掉 token 提交 → 回归普通文本重发（不碰目标）；goal 行改 token 后正文 → 目标更新为新正文；对 goal 行 retry → 按原目标重发。
23. **goal 行编辑卡形态**（规则 18，2026-10-07 增补）：打开 `/goal 完成计划` 这类行的编辑卡 → `/goal` 显示为带图标的命令芯片、「完成计划」染蓝，与气泡和命令面板同形态；不改字直接提交 → 行为与直接发送一致（目标正文不含 token）。sendText 行与旧 snapshot 开卡维持纯文本，原文含 `/goal` 字样时正文照旧染蓝。
24. **goal 重发落库形态**（规则 8 落库形态，2026-10-07 增补）：普通消息编辑成 `/goal 修复登录` 提交 → 新落库行的可见文本为编辑原文（含 token），目标仍为「修复登录」；对 goal 行 retry → 新行可见文本为 `/goal <原目标>`；两者的气泡都画出 goal 芯片与作用域染色（不再出现「目标设置成功但标志消失」）。
25. **编辑卡新增附件**（规则 41）：编辑带附件的历史消息 → 编辑卡 `+` 菜单出现附件项，经选择器/粘贴/外部拖放新增文件 → 新增件出现在编辑卡预览区并完成上传；保留原附件并新增一件提交 → 重发轮同时携带两者；删除全部原附件且不新增提交 → 重发轮无附件（显式 `[]` 语义不变）；新增件未上传完成时发送键禁用；编辑成 `/goal` 且带新增附件提交 → 被门禁拒绝（`guard.goalAttachmentsBlocked`），与直接发送同文案。

## 待定区（记录，不实现）

- **重发 turn 的上下文注入**：对话截断但文件保留（preserve/降级/覆盖路径）时，模型上下文与磁盘不一致（孤儿文件无解释）。竞品现状：Cursor/Codex 不注入（干净截断前缀 + 工具 I/O 即席感知）；Claude Code 的 system-reminder 同步有已知翻车案例（rewind 后 stale 状态污染模型认知）。若未来实现：经 `dynamic-sections` 管道在重发 turn 注入「对话已裁剪，工作区保留以下文件改动」，内容必须从投影**实时计算**，不得缓存回退前状态。

## 非目标

- 多分支/分支树语义（旧对话保留可切换）——明确不做，本 spec 锁定截断语义。
- 「只 Undo 不 Send」的两步中间态。
- 编辑 assistant 回复或 synthetic 消息。
- 被剪除对话的回收站/恢复入口。
