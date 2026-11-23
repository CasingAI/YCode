# Spec: sessions-index 活动帧合并与列表聚合成本分层

## 目标

重度使用（长会话 + 高频工具调用）时，侧栏任务列表链路不能随运行时长劣化 renderer 主线程。实测证据（`~/.zcode-dev-home/.zcode/v2/logs`，2026-11-22）：

- `sessions-index` 帧以 **4–13 帧/秒**到达（`sessions-index.frame` 每 10s 窗口 44–132 次），触发逐次 `sessions-index.items` 全量聚合。
- 卡死时段单次聚合最高 **408ms–4609ms**，同窗主线程长任务达 **16.5s / 24.6s / 20.4s**；`sessions-index.items` 是这些窗口里唯一慢的阶段。
- 增长因子：workspace 会话数（含 subagent 子会话）随使用时长单调增长，每帧聚合成本 O(全部会话)，分配风暴（每 tick 全量重建 meta + 逐字段 `Object.keys` 深比较）放大 GC 压力。

根因两层，必须同时成立才会表现为「跑一天后特别卡、reload renderer 即恢复」：

1. **CLI 侧**：`fanOutToIndex` 对非 `ModelStreaming` 事件无条件 `ingest → flushIndex`。活动事件（turn/tool 等）每次推进 `record.updatedAt`（= `summary.lastActivityAt`，见 `task-index-activity-time.md`），摘要必不等价 → 必产帧 → 立即直发。设计假设「conflated 低频列表事件」被工具事件频率打破。
2. **UI 侧**：`useWorkspaceSessionsIndexItems` 每个 tick 对全部 scope 的全部会话重跑映射 + 排序 + 稳定化，成本 O(全部会话)，且每字段分配比较。

## 规则

### 1. 帧分类：activity-only 与可见变化

分类事实源在 `SessionsIndexProjection`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts`）：

- **activity-only**：新旧摘要只在 `lastActivityAt` 上不同（其余字段全部等价，判定复用 `summariesEqual` 的单一比较表，加「忽略活动字段」开关，不另立第二份字段清单）。
- **可见变化**：其余任何字段变化（phase / sessionEnded / title / preview / 描边 / pendingInteraction / goal / error / workflow）。

### 2. 调度所有权：网关是唯一 flush 调度者

沿用既有约定「publisher 内部不持有定时器，调度归网关」：

- 可见变化 → **立即** `flushIndex`，行为与修复前一致（权限徽标、描边、终态不引入任何延迟）。
- activity-only → per-workspace **尾随合并窗口**（默认 500ms）：窗口已排队则合并（一次 flush 覆盖全部积压），未排队则起 unref 定时器；窗口到期一次 `flushIndex`。
- 窗口内穿插可见变化 → 可见变化立即 flush，同时清掉 pending 定时器；期间的活动增量已进 seq 账本，随该帧一并送达，无丢失。
- `projection` 永远即时推进（既有约定保持）：无订阅者或窗口未到时，下一次 subscribe snapshot 读到的仍是权威最新态；延迟只影响投递，不影响事实。
- 恢复/断档语义不变：conflated 最新态 + resume 失败退化 snapshot，合并投 delivery 与续传语义等价。

### 3. UI 聚合成本分层

`useWorkspaceSessionsIndexItems` 的聚合分两层缓存（纯函数模块 `packages/ui/src/v4/workspaceSessionsIndexMetas.ts`）：

- **scope 级**：store 代次（binding + logEpoch + seq + status）不变 → 整个 scope 复用上次 metas 数组（引用相等），零重算。帧只改一个 workspace 的 store，其余 scope 直接跳过。
- **会话级**：store 代次变化时逐条按 `SessionSummary` 引用判等，仅重映射引用变化的会话；其余复用旧 meta 对象。`previous` 取同 scope 同会话的上一条 meta（语义与原 `previousByKey` 一致；同 endpoint 隔离后比跨 endpoint 覆盖更准确）。
- 排序与 `stabilizeTaskListItems` 引用短路保持不变，继续兜底下游。
- 缓存边界：scope 集合协调（增删 scope）时同步增删缓存条目；会话被 remove 后，`byId` 缓存随下一次代次变化以当次 store 列表重建，无残留。

### 4. 时序

```text
CLI（每 workspace 一份调度）：
  活动事件 A1 ──▶ ingest（activity-only）──▶ 排 500ms 窗口（不直发）
  活动事件 A2 ──▶ ingest（activity-only）──▶ 已排队，合并
  可见事件 V1 ──▶ ingest（可见变化）──▶ 清 pending ──▶ 立即 flushIndex
                                                   （帧含 A1+A2+V1 的全部增量）
  （无可见事件）窗口到期 ──▶ flushIndex（一帧，最新 lastActivityAt）

UI（每 tick）：
  store 代次不变 ──▶ 复用 metas（O(scope 数)）
  store 代次变化 ──▶ 仅变化的 summary 重映射（O(变化会话)）──▶ sort + stabilize 引用短路
```

## 接口

- `sessions-index-projection.ts`：`upsertFromConversation` 返回 `{ deltas; activityOnly }`；`summariesEqual(a, b, { ignoreLastActivityAt })`。
- `sessions-index-publisher.ts`：`ingestConversation` 返回 `{ changed; activityOnly }`。
- `v4-gateway.ts`：`ConversationV4GatewayOptions.sessionsIndexActivityFlushWindowMs`（默认 500，测试注入小值）；`indexFlushTimers`（per-workspace，unref，`dispose` 清理）。
- `packages/ui/src/v4/workspaceSessionsIndexMetas.ts`：纯函数 `mapSessionsIndexScopeMetas`（scope 代次缓存 + summary 引用判等）。

## 验收场景

1. 连续 activity-only 事件在窗口内只产一帧，携带最新 `lastActivityAt`；窗口期内的后续活动不追加帧。
2. 可见变化（phase 翻转、描边变化、pendingInteraction、remove）立即到达，不受 pending 窗口影响，且包含此前积压的活动增量。
3. 冷启动种子 / 新订阅 snapshot 语义不变（snapshot 永远读权威最新态）。
4. UI：store 无新帧时聚合结果引用稳定；单会话变化仅重建该条 meta，其余引用复用；会话删除后缓存无残留；scope 撤销后缓存条目消失。

## 验证

- `apps/zcode-cli/packages/bootstrap/test/sessionsIndexActivityFlushCoalescing.test.ts`：真实 gateway → publisher → 订阅链路，注入小窗口验证合并、穿插可见变化、snapshot 语义。
- `packages/ui/test/workspaceSessionsIndexMetas.test.ts`：纯函数验证引用复用、previous 传播、删除淘汰。
- 运行方式：`node --import tsx --test <file>`（仓库无统一测试脚本）。
