# Spec: v4 命令对冷会话的按需恢复

## 目标

`v4/command`（`ConversationV4Gateway.handleCommand`，`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`）对「持久层有、内存注册表无」的冷会话，先按需恢复再裁决，而不是直接回 `proto.sessionNotFound`。修复「重新生成标题」对隔夜/重启后冷任务稳定失败（桌面与 Web 同病，host 日志：`v4 command regenerateSessionTitle rejected (proto.sessionNotFound)`，2.6ms FAIL，全程无标题 sidecar 调用）。

## 现象与根因

命令入口 `handleCommand` → `CommandInbox.decide` 里 `getRevision`（`v4-gateway.ts:711-714`）只看内存 `context.sessions`（经 `host.sessionExists`）；常驻池（`session-resident-pool.ts`：目标 8 / 高水位 16 / 空闲 10min）回收后，冷会话直接被拒在 `requireRecord` 与 core 执行之前。

冷恢复能力已存在但只挂在订阅/查询路径：`ColdSessionResumeCoordinator.ensureResumed`（`cold-session-resume.ts`，按会话单飞）→ 宿主 `resumePersistedSession`（`v4-bridge.ts:1516`，查 store → `activateSessionForResume` 回填注册表）→ `ensureColdReadyPublisher` 水位。先例形状：订阅（`subscribe:1447-1466`，用 `hasLiveConversation` 判定）、`ensureHostRecordForJournalRead`（`:2001-2004`，`!hasLiveConversation → ensureResumed`）、`attachmentBegin`（`:2082-2084`，`!sessionExists → ensureResumed`）。

## 产品规则

### 恢复触发

命令 `envelope.sessionId` 非空、且 `!host.sessionExists(sessionId)` 时，`await this.coldResume.ensureResumed(sessionId)` 后再进 `inbox.handle`。`detachedLiveSessions`（dwf actor 这类真 runtime 活在别处、宿主刻意无 record 的会话，见 `ensureHostRecordForJournalRead` 注释）必须沿用 `hasLiveConversation` 判定（`:3676`），不得仅看 `sessionExists`——否则会在此物化出第二个幽灵 runtime，双写事件日志、转录定格。

### 错误分型（不靠错误文本分流）

- store 里也没有 / 宿主不支持恢复 → 回落既有 `proto.sessionNotFound` 拒绝语义，客户端行为不变。
- 恢复中途失败 → 同样回落 `proto.sessionNotFound`（内存仍无 record，inbox 必然如此裁决；恢复的原始 cause 经 `host.onError("v4.command.coldResume")` 留生产日志）。`fault.command.executionFailed` 只在恢复成功、后续 handler 执行抛错时出现。
- `createSession`（sessionId=null）不受影响。

### 影响面

受益的是全部 session-scoped 命令（regenerateSessionTitle、renameSession、stop、resolveInteraction、sendText 等）。`sendText` 直发冷会话过去必拒，修后恢复执行——这是修复而非回归。并发同会话命令沿用 per-session FIFO gate 串行；`ensureResumed` 自带单飞，重复触发合并。

## 状态所有者与事件顺序

```text
v4/command → 解析信封 → 非空 sessionId 且非 live → ensureResumed（单飞）
    → store 缺失 → 回落 proto.sessionNotFound（语义不变）
    → 恢复成功 → 注册表回填 → inbox 裁决 → handler 执行 → ACK
    → 恢复失败 → executionFailed（既有映射）
```

- **恢复唯一入口是 `ColdSessionResumeCoordinator.ensureResumed`**，不另开恢复路径；命令路径只做「只拉 record」的单飞恢复（与 `ensureHostRecordForJournalRead` 同形），不建 READY publisher——投影水位仍由后续裁决/执行链负责。
- **不改 `CommandInbox.decide`**：内存不存在仍是 rejected；恢复是网关前置步骤，保持裁决层纯粹。

## 迁移边界

`proto.sessionNotFound` 的语义与 reasonCode 不变；`CommandAck` 六态不变；常驻池参数与回收策略不变。

## 不在范围内

- 不做命令路径 speculative 预热；不断开 `readyFlights` 现有语义。
- 不改 `sendPrompt` 旧 op 路径与订阅路径。
- Web 远端的 `remoteSessionId` 透传是独立缺陷（services 接口/UI/adapter 三层丢失），另见本次同批改动，不属本 spec。

## 验收

1. CLI 重启（或等回收）后，对冷任务发 `regenerateSessionTitle` → 成功，新标题回流，Header/侧栏/分组三处更新，无失败 toast。
2. 热会话命令 → 行为不变（无额外恢复开销的回归）。
3. store 里不存在的会话 → 仍 `proto.sessionNotFound` 拒绝，客户端 toast 不变。
4. 恢复中途失败 → `executionFailed`，不卡住同 session 后续命令（gate 正常释放）。
5. 并发两条同会话命令 → 只恢复一次（单飞），两条都执行。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；bootstrap 新增冷会话命令测试，core `session-title-regeneration.test.ts` 9 用例回归。
