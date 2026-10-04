// 工具行的语义归类谓词：分组与回合汇总共用同一份定义。
// 「什么算查阅 / 终端 / 编辑」必须只有一处答案，否则分组显示的类别会和汇总计数对不上。
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { isExecuteToolCall, isExploreToolCall } from "@/lib/exploreToolCall.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

export const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";

export const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

export function isExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

export function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExecuteToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

export function isChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return resolveToolCallIdentity(toolCallRowToLegacyNode(row).toolCall).family === "file-write";
}
