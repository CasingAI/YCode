// SendMessage 行「已发送 给 XXX」的运行中子代理身份补位索引（spec:
// send-message-open-subagent-side-pane.md）。与行派生索引同形、同键空间，独立成文件
// 是为不把 conversationAssistantWorkItems 再撑过行数上限；依赖方向单一：
// 这里只依赖行派生索引的类型，行派生索引不知道本文件的存在。
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import type { AgentSessionIdentity } from "@/v4/conversationAssistantWorkItems.js";

/**
 * 会话权威投影（`snapshot.subagents.running`）的只读补位索引。
 *
 * {@link import("./conversationAssistantWorkItems.js").buildAgentSessionByIdentity} 只从
 * 已加载行窗口派生；而 SendMessage 自身不产生 SubagentRow（只有 Agent spawn/resume 发
 * `SubagentSpawned`），目标子智能体的行只存在于派生那一刻的轮次——长会话窗口截断或
 * 冷恢复后行不在窗内，行派生索引查空，对应 SendMessage 行静默退化为「只展开」。
 * 运行中子智能体的身份在 conversation 权威投影里有第二事实来源：`running[].agentId`
 * （= `SubagentRow.entityId`，与 `input.to` 同源），冷恢复经 `seedSubagents` 种子、
 * 运行期由 `materializeSubagentProjection` 维护。本函数把它整理成与行派生同形的索引；
 * `agentId` 缺席的项无法与 `input.to` 对上，不入索引。
 * 只做补位、不做权威覆盖：合并语义见 {@link mergeAgentSessionByIdentity}。
 */
export function buildRunningSubagentSessionByIdentity(
  running: readonly RunningSubagentSummary[],
): ReadonlyMap<string, AgentSessionIdentity> {
  const sessionByIdentity = new Map<string, AgentSessionIdentity>();
  for (const item of running) {
    const identity = item.agentId?.trim();
    const childSessionId = item.childSessionId.trim();
    const subagentType = item.subagentType.trim();
    if (!identity || !childSessionId || !subagentType || sessionByIdentity.has(identity)) continue;
    sessionByIdentity.set(identity, { childSessionId, subagentType });
  }
  return sessionByIdentity;
}

/**
 * 行派生身份索引与快照 running 补位索引的合并：行派生优先，overlay 只补缺。
 *
 * 同一 `agent_<uuid>` 两边都有时以行为准——行是唯一权威投影，快照 running 只是
 * 窗口截断/冷恢复场景下的补位事实来源。overlay 缺席或为空时原样返回 rowDerived，
 * 保住行索引 memo 的引用复用（调用方得以跳过下游 memo 失效）。
 */
export function mergeAgentSessionByIdentity(
  rowDerived: ReadonlyMap<string, AgentSessionIdentity>,
  overlay: ReadonlyMap<string, AgentSessionIdentity> | undefined,
): ReadonlyMap<string, AgentSessionIdentity> {
  if (!overlay || overlay.size === 0) return rowDerived;
  const merged = new Map(rowDerived);
  for (const [identity, session] of overlay) {
    if (!merged.has(identity)) merged.set(identity, session);
  }
  return merged;
}
