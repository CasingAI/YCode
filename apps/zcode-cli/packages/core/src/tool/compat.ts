import { COMPACT_TOOL_ALIASES, COMPACT_TOOL_NAME } from "@zcode/contracts";

const AGENT_TOOL_NAME = "Agent";
export const TASK_TOOL_NAME = "Task";

const subagentDispatchToolNames = new Set<string>([AGENT_TOOL_NAME, TASK_TOOL_NAME]);

const hookMatcherAliasesByToolName = new Map<string, readonly string[]>([
  [AGENT_TOOL_NAME, [TASK_TOOL_NAME]],
  [TASK_TOOL_NAME, [AGENT_TOOL_NAME]],
  ["ApplyPatch", ["Write", "Edit"]],
  [COMPACT_TOOL_NAME, COMPACT_TOOL_ALIASES],
  ...COMPACT_TOOL_ALIASES.map((alias) => [alias, [COMPACT_TOOL_NAME]] as const),
]);

export function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName ? subagentDispatchToolNames.has(toolName) : false;
}

export function hookMatcherToolNamesForTool(toolName: string): readonly string[] {
  const aliases = hookMatcherAliasesByToolName.get(toolName) ?? [];
  if (aliases.length === 0) return [toolName];

  const values = new Set<string>([toolName]);
  for (const alias of aliases) values.add(alias);
  return [...values];
}
