import { CREATE_PLAN_TOOL_NAME } from "@zcode/contracts";
import { filterDisallowedToolNames } from "../tool/tool-visibility.js";

const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [CREATE_PLAN_TOOL_NAME] as const;

export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  return [...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS, ...(disallowedTools ?? [])];
}

export function filterSubagentChildToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  // 子 agent 没有独立的计划恢复面，暴露计划工具会让 CreatePlan 卡住父 turn，
  // 因此所有子 agent 工具面统一剔除。
  return filterDisallowedToolNames(toolNames, buildSubagentChildDisallowRules(disallowedTools));
}
