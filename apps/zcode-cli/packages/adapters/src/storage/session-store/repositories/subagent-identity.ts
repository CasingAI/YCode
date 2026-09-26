import type { DatabaseSync } from "node:sqlite";
import {
  type SessionId,
  type SessionInfo,
  type SubagentIdentityBinding,
  type SubagentIdentityResolution,
} from "@zcode/contracts";

interface SubagentIdentityRow {
  agent_id: string;
  child_session_id: string;
  agent_type: string;
  profile: string;
  workspace_identity: string | null;
  workspace_root: string | null;
  context_reset_generation: number;
}

/** child session 的 taskType 只有这一个值能被采用成可执行 Agent。 */
const SUBAGENT_CHILD_TASK_TYPE = "subagent_child";

/**
 * 子会话 ID 的历史命名约定。旧版本没有身份索引，但 child session 一直按这个规则命名，
 * 因此可以据此在首次查询时校验并 lazy backfill，而不需要全库批量回填。
 */
export function legacyChildSessionIdForAgent(agentId: string): SessionId {
  return `sess_subagent_${agentId}` as SessionId;
}

/**
 * 写入 `agentId → childSessionId` 绑定。
 *
 * 幂等：同 `agentId` 重复写同一映射是 no-op。指向不同 child 是显式冲突，抛错而不是覆盖——
 * 覆盖会让旧 Agent 的 transcript 变成孤儿，SendMessage 会在错误的 child 上继续跑。
 * 调用方负责把本函数和 child session 创建放在同一事务里。
 */
export function saveSubagentIdentity(
  db: DatabaseSync,
  identity: SubagentIdentityBinding,
): void {
  const existing = findSubagentIdentityRow(db, identity.agentId);
  if (existing) {
    if (existing.child_session_id !== identity.childSessionId) {
      throw new Error(
        `Subagent identity conflict: ${identity.agentId} is already bound to ${existing.child_session_id}`,
      );
    }
    return;
  }
  const now = Date.now();
  db.prepare(
    `
      insert into subagent_identity (
        agent_id, child_session_id, agent_type, profile,
        workspace_identity, workspace_root, context_reset_generation,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    identity.agentId,
    identity.childSessionId,
    identity.agentType,
    // profile 列是 NOT NULL，绑定里缺 profile 时写空对象而不是 null。
    JSON.stringify(identity.profile ?? {}),
    identity.workspaceIdentity ?? null,
    identity.workspaceRoot ?? null,
    identity.contextResetGeneration,
    now,
    now,
  );
}

/**
 * 按 `agentId` 解析持久化身份。
 *
 * 命中身份行时必须能取到 child session 实体，否则返回 null——上层据此拒绝，
 * 不能把悬空绑定当成可执行 Agent。身份行不存在时走一次 lazy backfill：只信任
 * `subagent_${agentId}` 命名且 taskType 确为 subagent_child 的 child，其余一律不认。
 */
export function resolveSubagentIdentity(
  db: DatabaseSync,
  agentId: string,
  getSession: (sessionID: SessionId) => SessionInfo | null,
): SubagentIdentityResolution | null {
  const row = findSubagentIdentityRow(db, agentId);
  if (row) {
    const child = getSession(row.child_session_id as SessionId);
    if (!child || child.taskType !== SUBAGENT_CHILD_TASK_TYPE) return null;
    return { binding: decodeSubagentIdentityRow(row), child };
  }
  return backfillLegacySubagentIdentity(db, agentId, getSession);
}

function backfillLegacySubagentIdentity(
  db: DatabaseSync,
  agentId: string,
  getSession: (sessionID: SessionId) => SessionInfo | null,
): SubagentIdentityResolution | null {
  if (!agentId) return null;
  const child = getSession(legacyChildSessionIdForAgent(agentId));
  if (!child || child.taskType !== SUBAGENT_CHILD_TASK_TYPE) return null;
  // 旧记录没有 profile 快照。冷恢复拿不到原始 profile 时必须由上层回退到当前 profile 解析，
  // 不能在这里伪造一份；agentType 同样留空由上层按当前请求补齐。
  const binding: SubagentIdentityBinding = {
    agentId,
    childSessionId: String(child.id),
    agentType: "",
    profile: {},
    workspaceIdentity: child.workspaceID ? String(child.workspaceID) : undefined,
    workspaceRoot: child.directory,
    contextResetGeneration: 0,
  };
  saveSubagentIdentity(db, binding);
  return { binding, child };
}

function findSubagentIdentityRow(
  db: DatabaseSync,
  agentId: string,
): SubagentIdentityRow | undefined {
  return db.prepare("select * from subagent_identity where agent_id = ?").get(agentId) as
    | SubagentIdentityRow
    | undefined;
}

function decodeSubagentIdentityRow(row: SubagentIdentityRow): SubagentIdentityBinding {
  return {
    agentId: row.agent_id,
    childSessionId: row.child_session_id,
    agentType: row.agent_type,
    profile: decodeProfile(row.profile),
    workspaceIdentity: row.workspace_identity ?? undefined,
    workspaceRoot: row.workspace_root ?? undefined,
    contextResetGeneration: row.context_reset_generation,
  };
}

function decodeProfile(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
