import type { AgentTerminalOutput } from "@zcode/contracts";

export function formatParentGuideYield(output: AgentTerminalOutput): string | undefined {
  if (output.status !== "completed" || output.terminationReason !== "parent_guide") return undefined;
  return [
    "The subagent execution ended at a safe boundary because its parent received a user Guide.",
    "terminationReason: parent_guide",
    "Original task completion has not been confirmed. Completed tool results and the full transcript are preserved.",
    `agentId: ${output.agentId}`,
    ...(output.childSessionId ? [`childSessionId: ${output.childSessionId}`] : []),
    `canContinue: ${output.canContinue === true}`,
    "Use HistoryRead or HistorySearch with childSessionId to inspect the transcript. Use RelayToSubagent with agentId to continue this agent.",
  ].join("\n");
}
