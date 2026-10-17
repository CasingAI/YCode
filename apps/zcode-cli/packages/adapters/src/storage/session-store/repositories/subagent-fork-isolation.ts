import type { DatabaseSync } from "node:sqlite";
import type {
  SubagentExecutionClaim,
  SubagentExecutionClaimRequest,
  SubagentExecutionClaimResult,
  SubagentExecutionFence,
  SubagentForkAliasResolution,
  SubagentForkCheckpoint,
  SubagentForkCheckpointGraph,
  SubagentForkCheckpointRequest,
} from "@zcode/contracts";
import { tryDecodeJsonObject } from "../json.js";
import {
  backfillCheckpoint,
  boundaryUpperBoundMs,
  type CheckpointRow,
} from "./subagent-fork-checkpoint.js";

export { saveCheckpoint } from "./subagent-fork-checkpoint.js";

export function resolveCheckpointGraph(
  db: DatabaseSync,
  input: SubagentForkCheckpointRequest,
): SubagentForkCheckpointGraph {
  const parentMessages = db
    .prepare(
      "select id, data, time_created from message where session_id = ? order by time_created, id",
    )
    .all(input.parentSessionId) as unknown as {
    id: string;
    data: string;
    time_created: number;
  }[];
  const boundaryIndex = parentMessages.findIndex((row) => row.id === input.boundaryMessageId);
  if (boundaryIndex < 0) {
    throw new Error(`Fork boundary cannot be proven: ${input.boundaryMessageId}`);
  }
  const boundaryMessageIds = new Set(
    parentMessages.slice(0, boundaryIndex + 1).filter((row) => {
      const data = tryDecodeJsonObject(row.data);
      const anchor = data?.anchor as Record<string, unknown> | undefined;
      return anchor?.origin === "realUser" && anchor?.sourceCommandId != null;
    }).map((row) => row.id),
  );
  const boundaryData = tryDecodeJsonObject(parentMessages[boundaryIndex]!.data);
  const orderedIds = boundaryData?.anchor?.orderedMessageIds;
  const explicitHistoryIds = Array.isArray(orderedIds)
    ? new Set((orderedIds as unknown[]).filter((id): id is string => typeof id === "string"))
    : null;
  if (explicitHistoryIds) {
    for (const id of [...boundaryMessageIds]) {
      if (!explicitHistoryIds.has(id)) boundaryMessageIds.delete(id);
    }
  } else if (boundaryData?.anchor?.origin === "realUser") {
    for (const id of [...boundaryMessageIds]) {
      if (id !== input.boundaryMessageId) boundaryMessageIds.delete(id);
    }
  }
  const readCheckpointRows = (): CheckpointRow[] =>
    db
      .prepare(
        "select * from subagent_fork_checkpoint where parent_session_id = ? order by time_created",
      )
      .all(input.parentSessionId) as unknown as CheckpointRow[];
  let rows = readCheckpointRows();
  const childRows = db.prepare(
    "select id, parent_id, time_created from session where task_type = 'subagent_child'",
  ).all() as unknown as { id: string; parent_id: string | null; time_created: number }[];
  const childParents = new Map(childRows.map((child) => [child.id, child.parent_id]));
  const checkpointedChildren = new Set(rows.map((row) => row.child_session_id));
  // 边界之后才创建的 child 不在被 Fork 的 transcript 里：它既不能要求边界内快照，
  // 也不能阻断更早历史的 Fork。边界上界取消息完成时刻（assistant）或创建时刻（user），
  // 覆盖“同一条 assistant 消息内派生的 child”——它们的创建时间晚于消息 created，
  // 但派生关系仍在边界内。时间只用于圈定候选集合，所有权和快照完整性仍逐项校验。
  const boundaryUpperBound = boundaryUpperBoundMs(
    parentMessages[boundaryIndex]!.time_created,
    boundaryData,
  );
  const scopedChildren = childRows.filter(
    (child) =>
      child.parent_id === input.parentSessionId && child.time_created <= boundaryUpperBound,
  );
  let backfilled = false;
  if (boundaryMessageIds.size > 0) {
    for (const child of scopedChildren) {
      if (checkpointedChildren.has(child.id)) continue;
      // 历史版本只在会话创建时尝试登记检查点，而那时 child 还没有消息，导致
      // subagent_fork_checkpoint 长期为空。这里按首条 user prompt 重建边界快照；
      // 证明不了身份或边界时保持原来的显式失败，不静默跳过。
      if (!backfillCheckpoint(db, input.parentSessionId, child.id, parentMessages)) {
        throw new Error(`Cannot prove immutable subagent snapshot at Fork boundary for ${child.id}`);
      }
      checkpointedChildren.add(child.id);
      backfilled = true;
    }
    // 回填写入的新行必须重新读取；沿用旧快照会让刚补齐的 child 在后续筛选里消失。
    if (backfilled) rows = readCheckpointRows();
  }
  const assertAcyclic = (childSessionId: string, ancestors: Set<string>): void => {
    if (ancestors.has(childSessionId)) throw new Error(`Subagent checkpoint graph contains a cycle: ${childSessionId}`);
    const aliasChildren = db
      .prepare("select child_session_id as id from subagent_fork_alias where child_session_id = ?")
      .all(childSessionId) as unknown as { id: string }[];
    const next = new Set(ancestors);
    next.add(childSessionId);
    for (const child of aliasChildren) assertAcyclic(child.id, next);
  };
  for (const row of rows) assertAcyclic(row.child_session_id, new Set());
  // 一个 child 可以在多个父历史锚点保存检查点；只取目标边界内最后一个，
  // 否则同一逻辑 Agent 会被复制多次，并产生冲突的分支别名。
  const messageOrder = new Map(parentMessages.map((row, index) => [row.id, index]));
  const latestByChild = new Map<string, CheckpointRow>();
  for (const row of rows) {
    if (!boundaryMessageIds.has(row.boundary_message_id)) continue;
    const previous = latestByChild.get(row.child_session_id);
      if (
        childParents.get(row.child_session_id) !== row.parent_session_id ||
        !row.parent_tool_call_id.trim()
      ) {
        throw new Error(`Subagent checkpoint ownership or tool relation cannot be proven: ${row.agent_id}`);
      }
      if (!previous || messageOrder.get(row.boundary_message_id)! > messageOrder.get(previous.boundary_message_id)!) {
      latestByChild.set(row.child_session_id, row);
    } else if (row.boundary_message_id === previous.boundary_message_id && row.agent_id !== previous.agent_id) {
      throw new Error(`Subagent checkpoint identity conflicts at Fork boundary: ${row.child_session_id}`);
    }
  }
  const children = [...latestByChild.values()]
    .map((row) => {
      const checkpoint = decodeCheckpointRowForGraph(row);
      if (checkpoint.parentSessionId !== input.parentSessionId) {
        throw new Error(`Subagent checkpoint parent ownership mismatch: ${checkpoint.agentId}`);
      }
      const child = db.prepare("select parent_id, task_type from session where id = ?").get(
        checkpoint.childSessionId,
      ) as { parent_id: string | null; task_type: string | null } | undefined;
      if (!child || child.task_type !== "subagent_child" || child.parent_id !== input.parentSessionId) {
        throw new Error(`Subagent checkpoint child ownership mismatch: ${checkpoint.agentId}`);
      }
      return { checkpoint, history: checkpoint.history };
    });
  return { boundaryMessageId: input.boundaryMessageId, children };
}

export function saveAlias(
  db: DatabaseSync,
  parentSessionId: string,
  historicalAgentId: string,
  physicalAgentId: string,
  childSessionId: string,
  sourceCheckpointId: string,
): void {
  const existing = db.prepare(
    "select physical_agent_id, child_session_id from subagent_fork_alias where parent_session_id = ? and historical_agent_id = ?",
  ).get(parentSessionId, historicalAgentId) as
    | { physical_agent_id: string; child_session_id: string }
    | undefined;
  if (existing) {
    if (existing.physical_agent_id !== physicalAgentId || existing.child_session_id !== childSessionId) {
      // 同一父分支可经新的 Fork 操作产生另一子分支；该 alias 是新父 session 下的事实，不覆盖旧 scope。
      throw new Error(`Subagent fork alias conflict: ${historicalAgentId}`);
    }
    return;
  }
  db.prepare(
    "insert into subagent_fork_alias(parent_session_id,historical_agent_id,physical_agent_id,child_session_id,source_checkpoint_id) values (?,?,?,?,?)",
  ).run(parentSessionId, historicalAgentId, physicalAgentId, childSessionId, sourceCheckpointId);
}

export function resolveAlias(
  db: DatabaseSync,
  parentSessionId: string,
  agentId: string,
): SubagentForkAliasResolution | null {
  let currentSessionId = parentSessionId;
  let currentAgentId = agentId;
  const visited = new Set<string>();
  while (true) {
    const key = `${currentSessionId}:${currentAgentId}`;
    if (visited.has(key)) throw new Error(`Subagent fork alias cycle: ${key}`);
    visited.add(key);
    const row = db
      .prepare(
        "select parent_session_id, historical_agent_id, physical_agent_id, child_session_id from subagent_fork_alias where parent_session_id = ? and historical_agent_id = ?",
      )
      .get(currentSessionId, currentAgentId) as
      | {
          parent_session_id: string;
          historical_agent_id: string;
          physical_agent_id: string;
          child_session_id: string;
        }
      | undefined;
    if (!row) return null;
    return {
      parentSessionId: row.parent_session_id,
      historicalAgentId: agentId,
      physicalAgentId: row.physical_agent_id,
      childSessionId: row.child_session_id,
    };
  }
}

export function acquireClaim(
  db: DatabaseSync,
  input: SubagentExecutionClaimRequest,
): SubagentExecutionClaimResult {
  const child = db.prepare("select task_type from session where id = ?").get(input.childSessionId) as
    | { task_type: string | null }
    | undefined;
  if (!child || child.task_type !== "subagent_child") {
    throw new Error(`Execution claim target is not a subagent child: ${input.childSessionId}`);
  }
  if (!input.ownerRuntimeId.trim() || !Number.isFinite(input.now) || !Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
    throw new Error("Execution claim request is invalid");
  }
  const existing = db
    .prepare("select * from subagent_execution_claim where child_session_id = ?")
    .get(input.childSessionId) as
    | { child_session_id: string; owner_runtime_id: string; fencing_epoch: number; expires_at: number }
    | undefined;
  if (existing && existing.expires_at > input.now) {
    return { acquired: false };
  }
  const epoch = (existing?.fencing_epoch ?? 0) + 1;
  const expiresAt = input.now + Math.max(1, input.leaseMs);
  db.prepare(
    `insert into subagent_execution_claim(child_session_id,owner_runtime_id,fencing_epoch,expires_at)
     values (?,?,?,?) on conflict(child_session_id) do update set
       owner_runtime_id=excluded.owner_runtime_id, fencing_epoch=excluded.fencing_epoch, expires_at=excluded.expires_at`,
  ).run(input.childSessionId, input.ownerRuntimeId, epoch, expiresAt);
  return {
    acquired: true,
    claim: {
      childSessionId: input.childSessionId,
      ownerRuntimeId: input.ownerRuntimeId,
      fencingEpoch: epoch,
      expiresAt,
    },
  };
}

export function renewClaim(db: DatabaseSync, claim: SubagentExecutionClaim): boolean {
  const result = db
    .prepare(
      `update subagent_execution_claim set expires_at = ? where child_session_id = ? and owner_runtime_id = ? and fencing_epoch = ? and expires_at > ?`,
    )
    .run(claim.expiresAt, claim.childSessionId, claim.ownerRuntimeId, claim.fencingEpoch, Date.now());
  return Number(result.changes) === 1;
}

export function releaseClaim(db: DatabaseSync, fence: SubagentExecutionFence): boolean {
  const result = db
    .prepare(
      // 保留已释放行的 epoch，防止同一 Runtime 再次获取时复用旧 token。
      "update subagent_execution_claim set expires_at = 0 where child_session_id = ? and owner_runtime_id = ? and fencing_epoch = ? and expires_at > 0",
    )
    .run(fence.childSessionId, fence.ownerRuntimeId, fence.fencingEpoch);
  return Number(result.changes) === 1;
}

export function assertClaimInTransaction(db: DatabaseSync, fence: SubagentExecutionFence): void {
  const row = db
    .prepare(
      "select 1 from subagent_execution_claim where child_session_id = ? and owner_runtime_id = ? and fencing_epoch = ? and expires_at > ?",
    )
    .get(fence.childSessionId, fence.ownerRuntimeId, fence.fencingEpoch, Date.now());
  if (!row) throw new Error(`Subagent execution fencing rejected stale writer: ${fence.childSessionId}`);
}

function decodeCheckpointRowForGraph(row: CheckpointRow): SubagentForkCheckpoint {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const history = (payload.history as SubagentForkCheckpoint["history"]) ?? [];
  const ids = JSON.parse(row.message_ids_json) as string[];
  if (
    history.length === 0 ||
    JSON.stringify(ids) !== JSON.stringify(history.map((message) => String(message.info.id)))
  ) {
    throw new Error(`Subagent immutable checkpoint is corrupt: ${row.agent_id}`);
  }
  return {
    checkpointId: row.checkpoint_id,
    parentSessionId: row.parent_session_id,
    agentId: row.agent_id,
    childSessionId: row.child_session_id,
    parentToolCallId: row.parent_tool_call_id,
    boundaryMessageId: row.boundary_message_id,
    agentType: String(payload.agentType ?? ""),
    profile: (payload.profile as Record<string, unknown>) ?? {},
    entries: (payload.entries as SubagentForkCheckpoint["entries"]) ?? [],
    aliases: (payload.aliases as string[]) ?? [],
    history,
  };
}
