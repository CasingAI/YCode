import type { DatabaseSync } from "node:sqlite";
import type {
  MessageWithParts,
  SubagentForkCheckpoint,
  SubagentForkCheckpointSaveResult,
} from "@zcode/contracts";
import { decodeMessageRow, decodePartRow } from "../codecs.js";
import { tryDecodeJsonObject } from "../json.js";
import type { MessageRow, PartRow } from "../rows.js";

export interface CheckpointRow {
  checkpoint_id: string;
  parent_session_id: string;
  agent_id: string;
  child_session_id: string;
  parent_tool_call_id: string;
  boundary_message_id: string;
  payload_json: string;
  message_ids_json: string;
  time_created: number;
}

export function saveCheckpoint(
  db: DatabaseSync,
  value: SubagentForkCheckpoint,
): SubagentForkCheckpointSaveResult {
  const current = db
    .prepare(
      `select * from subagent_fork_checkpoint where checkpoint_id = ?`,
    )
    .get(value.checkpointId) as
    | CheckpointRow
    | undefined;
  if (current) {
    const decoded = decodeCheckpoint(current);
    if (
      decoded.parentSessionId !== value.parentSessionId ||
      decoded.agentId !== value.agentId ||
      decoded.childSessionId !== value.childSessionId ||
      decoded.parentToolCallId !== value.parentToolCallId ||
      decoded.boundaryMessageId !== value.boundaryMessageId ||
      JSON.stringify(decoded.history) !== JSON.stringify(value.history) ||
      JSON.stringify(decoded.entries) !== JSON.stringify(value.entries) ||
      JSON.stringify(decoded.profile) !== JSON.stringify(value.profile) ||
      decoded.agentType !== value.agentType ||
      JSON.stringify(decoded.aliases ?? []) !== JSON.stringify(value.aliases ?? [])
    ) {
      throw new Error(
        `Subagent checkpoint is immutable and conflicts with persisted history: ${value.agentId}`,
      );
    }
    return { checkpoint: decoded, created: false };
  }
  const child = db
    .prepare("select parent_id, task_type from session where id = ?")
    .get(value.childSessionId) as { parent_id: string | null; task_type: string | null } | undefined;
  if (!child || child.task_type !== "subagent_child" || child.parent_id !== value.parentSessionId) {
    throw new Error(`Subagent checkpoint ownership cannot be proven for ${value.agentId}`);
  }
  const identity = db
    .prepare("select child_session_id from subagent_identity where agent_id = ?")
    .get(value.agentId) as { child_session_id: string } | undefined;
  if (!identity || identity.child_session_id !== value.childSessionId) {
    throw new Error(`Subagent checkpoint identity cannot be proven for ${value.agentId}`);
  }
  const messageIds = value.history.map((message) => String(message.info.id));
  const storedIds = db
    .prepare(
      `select id from message where session_id = ?
       order by sequence is null, sequence, time_created, rowid`,
    )
    .all(value.childSessionId) as unknown as { id: string }[];
  // 检查点锚定在父历史边界，只包含当时的 child 前缀；边界之后追加的消息不属于快照。
  // 因此这里要求 payload 是已存消息的严格前缀，而不是完整相等——否则历史 child 在补齐
  // 检查点时永远无法通过校验，Fork 会退回“缺失检查点”的失败分支。
  const storedMessageIds = storedIds.map((row) => row.id);
  if (
    messageIds.length === 0 ||
    messageIds.length > storedMessageIds.length ||
    messageIds.some((id, index) => storedMessageIds[index] !== id) ||
    messageIds.some((id) => id.length === 0) ||
    new Set(messageIds).size !== messageIds.length ||
    value.history.some((message) =>
      String(message.info.sessionID) !== value.childSessionId ||
      message.parts.some(
        (part) =>
          String(part.sessionID) !== value.childSessionId ||
          String(part.messageID) !== String(message.info.id),
      ),
    )
  ) {
    throw new Error(`Subagent checkpoint is incomplete or not child-local: ${value.agentId}`);
  }
  const payload = JSON.stringify({
    agentType: value.agentType,
    profile: value.profile,
    entries: value.entries,
    aliases: value.aliases ?? [],
    history: value.history,
  });
  db.prepare(
    `insert into subagent_fork_checkpoint
      (checkpoint_id,parent_session_id,agent_id,child_session_id,parent_tool_call_id,boundary_message_id,payload_json,message_ids_json,time_created)
      values (?,?,?,?,?,?,?,?,?)`,
  ).run(
    value.checkpointId,
    value.parentSessionId,
    value.agentId,
    value.childSessionId,
    value.parentToolCallId,
    value.boundaryMessageId,
    payload,
    JSON.stringify(messageIds),
    Date.now(),
  );
  return { checkpoint: value, created: true };
}

export function boundaryUpperBoundMs(
  fallback: number,
  boundaryData: Record<string, any> | undefined,
): number {
  const time = boundaryData?.time;
  if (typeof time?.completed === "number") return time.completed;
  if (typeof time?.created === "number") return time.created;
  return fallback;
}

interface ParentMessageRow {
  id: string;
  data: string;
  time_created: number;
}

/**
 * 回填结果。
 *
 * - `backfilled`：已按首条 realUser prompt 前缀重建并持久化检查点，child 可继承。
 * - `no_history`：child 没有任何转写内容，没有可继承历史（不是证据不足）。
 * - `outside_boundary`：child 的可证明父锚点落在本次 Fork 的可继承锚点之外，
 *   它不在复制范围内（不是证据不足）。
 * - `unprovable`：child 有内容但证据不足（缺身份、缺 prompt 或缺父锚点），Fork 必须失败。
 */
export type SubagentCheckpointBackfillResult =
  | { status: "backfilled" }
  | { status: "no_history" }
  | { status: "outside_boundary" }
  | { status: "unprovable" };

/**
 * 为缺失检查点的历史 child 重建边界快照。
 *
 * 快照内容固定为 child 的首条 realUser prompt 及其之前的初始化事件：这是父历史锚点
 * 形成时可证明的 child 前缀，不读取之后追加的执行历史。身份、父归属与消息完整性仍由
 * saveCheckpoint 校验；任一证据缺失时返回 `unprovable`，由调用方显式失败。
 *
 * `inheritableAnchorMessageIds` 是本次 Fork 可继承的父 realUser 锚点集合：child 的可证明
 * 锚点落在集合外时，说明它不在复制范围内，返回 `outside_boundary` 而不写入检查点。
 * 这一判据与复制图本身使用的筛选完全一致，避免「本就会被排除的 child 反而让 Fork 失败」。
 */
export function backfillCheckpoint(
  db: DatabaseSync,
  parentSessionId: string,
  childSessionId: string,
  parentMessages: ParentMessageRow[],
  inheritableAnchorMessageIds: ReadonlySet<string>,
): SubagentCheckpointBackfillResult {
  // 启动即失败的派发只留下 child 会话行与身份，没有任何 message/part：它在模型准入
  // 阶段就被拒绝，从未产出转写，因此是「没有历史」而不是「证据不足」。判据只看持久
  // 转写是否为空，不看失败原因或时间戳。
  if (!hasChildTranscript(db, childSessionId)) return { status: "no_history" };
  const identity = db
    .prepare(
      "select agent_id, agent_type, profile from subagent_identity where child_session_id = ?",
    )
    .get(childSessionId) as
    | { agent_id: string; agent_type: string; profile: string }
    | undefined;
  if (!identity) return { status: "unprovable" };
  const history = loadChildHistory(db, childSessionId);
  const promptIndex = history.findIndex(
    (message) =>
      message.info.role === "user" &&
      (message.info.anchor?.origin === "realUser" ||
        message.info.semantics?.origin === "real_user"),
  );
  if (promptIndex < 0) return { status: "unprovable" };
  const snapshot = history.slice(0, promptIndex + 1);
  const promptCreatedAt = snapshot[snapshot.length - 1]!.info.time.created;
  const boundary = [...parentMessages].reverse().find((row) => {
    if (row.time_created > promptCreatedAt) return false;
    const data = tryDecodeJsonObject(row.data);
    return (
      data?.role === "user" &&
      data?.anchor?.origin === "realUser" &&
      data?.anchor?.sourceCommandId != null
    );
  });
  if (!boundary) return { status: "unprovable" };
  // 锚点可证明但落在可继承范围之外：child 不在复制图内，既不写检查点也不阻断 Fork。
  if (!inheritableAnchorMessageIds.has(boundary.id)) return { status: "outside_boundary" };
  let profile: Record<string, unknown>;
  try {
    profile = (JSON.parse(identity.profile) as Record<string, unknown>) ?? {};
  } catch {
    return { status: "unprovable" };
  }
  const checkpointId = `subagent-checkpoint:${childSessionId}:${boundary.id}`;
  try {
    saveCheckpoint(db, {
      checkpointId,
      parentSessionId,
      agentId: identity.agent_id,
      childSessionId,
      parentToolCallId: identity.agent_id,
      boundaryMessageId: boundary.id,
      history: snapshot,
      entries: [],
      profile,
      agentType: identity.agent_type,
    });
  } catch (error) {
    // 并发 Fork 可能同时回填同一检查点；确定性 id + 快照内容一致时视为已存在。
    const existing = db
      .prepare("select 1 from subagent_fork_checkpoint where checkpoint_id = ?")
      .get(checkpointId);
    if (!existing) throw error;
  }
  return { status: "backfilled" };
}

/** child 是否留下任何转写内容（message 或 part）。 */
function hasChildTranscript(db: DatabaseSync, childSessionId: string): boolean {
  const messages = db
    .prepare("select count(*) as total from message where session_id = ?")
    .get(childSessionId) as { total: number };
  if (messages.total > 0) return true;
  const parts = db
    .prepare("select count(*) as total from part where session_id = ?")
    .get(childSessionId) as { total: number };
  return parts.total > 0;
}

function loadChildHistory(db: DatabaseSync, childSessionId: string): MessageWithParts[] {
  const messageRows = db
    .prepare(
      `select * from message where session_id = ?
       order by sequence is null, sequence, time_created, rowid`,
    )
    .all(childSessionId) as unknown as MessageRow[];
  const partRows = db
    .prepare(
      `select * from part where session_id = ?
       order by message_id, sequence is null, sequence, time_created, id`,
    )
    .all(childSessionId) as unknown as PartRow[];
  const partsByMessage = new Map<string, MessageWithParts["parts"]>();
  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }
  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

function decodeCheckpoint(row: CheckpointRow): SubagentForkCheckpoint {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const history = (payload.history as SubagentForkCheckpoint["history"]) ?? [];
  const messageIds = JSON.parse(row.message_ids_json) as string[];
  const actualIds = history.map((message) => String(message.info.id));
  if (JSON.stringify(messageIds) !== JSON.stringify(actualIds) || history.length === 0) {
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
    history,
    aliases: (payload.aliases as string[]) ?? [],
  };
}
