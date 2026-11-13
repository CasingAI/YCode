import type { SessionInfo } from "@zcode/contracts";

/**
 * 冷恢复 Agent 的任务短描述：取 child session 的持久化 title，空白时回退稳定短标识。
 * profile.description 是 Subagent 类型说明，不得充作任务描述。
 */
export function resolveRecoveredAgentDescription(
  child: Pick<SessionInfo, "title">,
  agentId: string,
): string {
  return child.title?.trim() || `Recovered agent ${agentId}`;
}
