// 回合过程行的折叠投影：把连续过程行收成一行计数的纯函数。
// 单独成模块有两个原因：`conversationAssistantWorkItems` 有行数上限，且折叠逻辑
// 值得单测直接覆盖（不需要挂 React）。
import type {
  ConversationAssistantWorkChildItem,
  ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import {
  isChangesToolCallRow,
  isExecuteToolCallRow,
  isExploreToolCallRow,
} from "@/v4/conversationToolRowClass.js";
import {
  TURN_PROCESS_BUCKETS,
  type ProcessBucket,
  type ProcessCounts,
} from "@/v4/conversationProcess.js";
import { classifyToolCallActivity } from "@/lib/toolCallActivity.js";

/**
 * 过程行归类：只认六种查阅活动、终端、编辑与思考。返回 null 的项
 * （正文、子智能体、CUA、产物、hook、timelineMarker）不参与折叠，必须在过程行之间原样铺开——
 * 正文被折进过程里，回合就读不出结论了。
 */
export function resolveProcessBucket(
  item: ConversationAssistantWorkChildItem,
): ProcessBucket | null {
  if (item.kind === "exploreGroup") {
    const firstRow = item.rows[0];
    if (!firstRow) return null;
    const activity = classifyToolCallActivity({
      toolName: firstRow.toolName,
      kind: firstRow.kind,
      input: firstRow.input,
      output: firstRow.output?.text,
    });
    return activity === "unknown" ? null : activity;
  }
  if (item.kind !== "row") return null;

  const { row } = item;
  if (row.kind === "reasoning") return "reasoning";
  if (row.kind !== "toolCall") return null;
  // 三个谓词互斥：file-write 家族被 isExploreToolCall/isExecuteToolCall 排除，只落入编辑桶。
  if (isExploreToolCallRow(row)) {
    const activity = classifyToolCallActivity({
      toolName: row.toolName,
      kind: row.kind,
      input: row.input,
      output: row.output?.text,
    });
    return activity === "unknown" ? null : activity;
  }
  if (isExecuteToolCallRow(row)) return "terminal";
  if (isChangesToolCallRow(row)) return "changes";
  return null;
}

/** 分组按子工具条数计（`rows.length`），单行计 1。 */
function resolveProcessItemCount(item: ConversationAssistantWorkChildItem): number {
  if (item.kind === "exploreGroup") {
    return item.rows.length;
  }
  return 1;
}

function resolveRenderItemRowId(item: ConversationAssistantWorkChildItem): number {
  if (item.kind === "row" || item.kind === "agentToolCall") return item.row.rowId;
  return item.rowId;
}

function countProcessBuckets(nodes: readonly ConversationAssistantWorkChildItem[]): ProcessCounts {
  const counts = Object.fromEntries(
    TURN_PROCESS_BUCKETS.map((bucket) => [bucket, 0]),
  ) as ProcessCounts;
  for (const node of nodes) {
    if (node.kind === "exploreGroup") {
      for (const row of node.rows) {
        const activity = classifyToolCallActivity({
          toolName: row.toolName,
          kind: row.kind,
          input: row.input,
          output: row.output?.text,
        });
        if (activity !== "unknown") counts[activity] += 1;
      }
      continue;
    }
    const bucket = resolveProcessBucket(node);
    if (!bucket) continue;
    counts[bucket] += resolveProcessItemCount(node);
  }
  return counts;
}

/**
 * 把连续过程行折叠成一行。纯投影：不改变输入，行序只在过程行内部被包一层。
 * 连续段即使只有一项也折叠——「过程永远只有一行」比「偶尔多一行」更可预期。
 */
export function foldProcessRows(
  items: readonly ConversationAssistantWorkChildItem[],
  stageTailIsRunning: boolean,
): ConversationAssistantWorkRenderItem[] {
  const folded: ConversationAssistantWorkRenderItem[] = [];
  let index = 0;
  while (index < items.length) {
    const node = items[index]!;
    if (!resolveProcessBucket(node)) {
      folded.push(node);
      index += 1;
      continue;
    }
    const nodes: ConversationAssistantWorkChildItem[] = [];
    while (index < items.length) {
      const next = items[index]!;
      if (!resolveProcessBucket(next)) break;
      nodes.push(next);
      index += 1;
    }
    const first = nodes[0]!;
    folded.push({
      kind: "process",
      key: `process:${first.key}`,
      rowId: resolveRenderItemRowId(first),
      nodes,
      counts: countProcessBuckets(nodes),
      // 只有真正位于可见工作段末尾的那一段才算运行中：后面已经出现别的行时，
      // 这一段的过程已经结束，不该继续强制展开。
      running: stageTailIsRunning && index === items.length,
    });
  }
  return folded;
}
