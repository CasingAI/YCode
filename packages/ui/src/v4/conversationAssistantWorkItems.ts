import type { ConversationRow, SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { isShellToolCallAwaitingCommand } from "@/lib/exploreToolCall.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { foldProcessRows } from "@/v4/conversationProcessFold.js";
import type { ProcessCounts } from "@/v4/conversationProcess.js";
import {
  isAgentToolCallRow,
  isExploreToolCallRow,
  isToolCallRow,
} from "@/v4/conversationToolRowClass.js";
import { isPermissionDeniedToolCallRow, toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { getAgentPrimaryText } from "@/ToolCallBlocks/renderers/agentHelpers.js";
import { isSafeVisibleToolTitle } from "@/ToolCallBlocks/renderers/visibleToolIdentity.js";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroups,
  type ConversationCuaGroupRenderItem,
} from "@/v4/conversationCuaGroups.js";

/** 未折叠的渲染项：顶层列表与过程行内容共用同一套分发。 */
export type ConversationAssistantWorkChildItem =
  | {
      kind: "row";
      key: string;
      row: AssistantWorkRow;
    }
  | {
      kind: "exploreGroup";
      key: string;
      rowId: number;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | ConversationCuaGroupRenderItem
  | {
      kind: "agentToolCall";
      key: string;
      row: ToolCallRow;
      subagentRow: SubagentRow;
    };

/** 过程行的计数桶（`ProcessBucket`）定义在 `conversationProcess`，投影与文案共用同一套词汇。 */
export interface ConversationProcessRenderItem {
  kind: "process";
  /**
   * 折叠身份锚定首个子项：流式追加子项时 React identity 与展开态都不重建，
   * 与 explore/execute/changes 分组锚定首个 tool 的做法一致。
   */
  key: string;
  rowId: number;
  nodes: ConversationAssistantWorkChildItem[];
  counts: ProcessCounts;
  /** 该过程行位于当前运行工作段尾部：强制展开，段结束后回归用户展开态。 */
  running: boolean;
}

export type ConversationAssistantWorkRenderItem =
  | ConversationAssistantWorkChildItem
  | ConversationProcessRenderItem;

export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export { ENABLE_CUA_TOOL_CALL_GROUPING } from "@/v4/conversationCuaGroups.js";
// 终端不分组：会话里的终端分组只可能嵌在回合过程行内部，等于给同一批命令叠第二道折叠。
// 详见 docs/specs/conversation-process.md「终端桶只有一条形态」。
// 编辑同理不分组：写入行与终端行同款单行铺开，由过程行折成「编辑 N 次」。
export const ENABLE_TURN_PROCESS = true;

interface ConversationAssistantWorkRenderOptions {
  stageTailIsRunning?: boolean;
  enableCuaGrouping?: boolean;
  enableExploreGrouping?: boolean;
  enableProcess?: boolean;
}

function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function resolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  // Explore/Execute 父节点表达的是当前工作阶段，不是子工具执行状态的聚合。
  // 子工具可能已经全部完成，但只要当前运行工作段尚未出现下一条可见边界，父阶段仍在继续；
  // 反之，后续非当前分组内容已经出现时，即使迟到的子状态仍是 running，父阶段也必须结束。
  if (stageTailIsRunning) return "in_progress";
  if (rows.some(isPermissionDeniedToolCallRow)) return "denied";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

function buildExploreGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  // 分组 builder 只会在连续同类工具达到两项后调用；空数组不是合法状态，
  // 不再用伪造 identity 的兜底掩盖调用方错误。
  const firstRow = rows[0]!;
  const childToolCalls = rows.map(toolCallRowToLegacyNode);

  return {
    kind: "exploreGroup" as const,
    // 旧 key/toolId 包含末尾 row 和数量，每新增一个 Explore 子工具都会重建组件，
    // 并让 ToolLayout 用新的 toolId 读取不到用户刚保存的展开状态。聚合身份锚定首个子工具，
    // 后续只更新 children，保证流式增长期间 React identity 和展开状态 identity 都稳定。
    key: `explore:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `explore:${firstRow.toolCallId}`,
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls,
    },
  };
}

/**
 * Agent 工具行 ↔ subagent 行必须按 parentToolCallId 精确配对。
 *
 * 同一轮并发 Agent 工具的 tool call 行按模型输出顺序出现，但 SubagentSpawned
 * 事件按异步调度顺序到达；旧 FIFO 会把一个 Agent 的标题与另一个 childSessionId 拼在一起。
 * 仅对缺少新字段的历史数据保留“同 turn 唯一剩余一对”的无歧义兼容。
 */
function pairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (isAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(`${row.turnId}\0${row.toolCallId}`, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(`${row.turnId}\0${row.parentToolCallId}`);
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  for (const [turnId, subagentRows] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRows.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRows[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "hookInvocation";
}

/**
 * 建立 SubagentRow entityId 到用户可见 Agent 标题的只读索引。
 *
 * 索引只消费已加载会话行中的 Agent/Subagent 投影；配对规则沿用回合内的
 * parentToolCallId 精确匹配和旧数据唯一剩余项回退，不改变工具执行或任务身份。
 */
export function buildAgentTitleByIdentity(
  rows: readonly ConversationRow[],
): ReadonlyMap<string, string> {
  const assistantRows = rows.filter(isAssistantWorkRow);
  const { subagentByAgentToolRowId } = pairSubagentRows(assistantRows);
  const agentRowsById = new Map<number, ToolCallRow>();
  const subagentRows: SubagentRow[] = [];

  for (const row of assistantRows) {
    if (isAgentToolCallRow(row)) {
      agentRowsById.set(row.rowId, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }

  const agentRowBySubagentRowId = new Map<number, ToolCallRow>();
  for (const [agentRowId, subagentRow] of subagentByAgentToolRowId) {
    const agentRow = agentRowsById.get(agentRowId);
    if (agentRow) {
      agentRowBySubagentRowId.set(subagentRow.rowId, agentRow);
    }
  }

  const titleByIdentity = new Map<string, string>();
  for (const subagentRow of subagentRows) {
    const identity = subagentRow.entityId?.trim();
    if (!identity) continue;

    const agentRow = agentRowBySubagentRowId.get(subagentRow.rowId);
    const agentTitle = agentRow
      ? getAgentPrimaryText(toolCallRowToLegacyNode(agentRow).toolCall, "")
      : "";
    const visibleTitle = [agentTitle, subagentRow.summaryText, subagentRow.subagentType].find(
      isSafeVisibleToolTitle,
    );
    if (visibleTitle) {
      titleByIdentity.set(identity, visibleTitle.trim());
    }
  }
  return titleByIdentity;
}

function sameRowIdentitySequence(
  previous: readonly ConversationRow[],
  current: readonly ConversationRow[],
): boolean {
  if (previous.length !== current.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== current[index]) return false;
  }
  return true;
}

/**
 * 子智能体标题索引的跨帧缓存。
 *
 * 这个索引会被塞进每个 turn 的渲染 context，只要它换新 Map，所有已挂载 turn 的
 * memo 就全部失效——哪怕这一帧一个子智能体行都没动。而它的输入是整窗 rows，
 * 每次都要 filter 加一轮 subagent 配对，在长历史里并不便宜。
 *
 * 复用判据用行**对象引用**：`applyConversationDeltas` 只替换被 delta 命中的那一个
 * 行对象，未命中的原样保留，所以引用全等就是「这一帧没有任何相关行变化」。
 */
export class AgentTitleByIdentityMemo {
  private snapshot: {
    rows: readonly ConversationRow[];
    titleByIdentity: ReadonlyMap<string, string>;
  } | null = null;

  resolve(rows: readonly ConversationRow[]): ReadonlyMap<string, string> {
    if (this.snapshot && sameRowIdentitySequence(this.snapshot.rows, rows)) {
      return this.snapshot.titleByIdentity;
    }
    const titleByIdentity = buildAgentTitleByIdentity(rows);
    this.snapshot = { rows, titleByIdentity };
    return titleByIdentity;
  }

  /** 会话切换时释放：否则会把上一会话的行对象钉在内存里。 */
  clear(): void {
    this.snapshot = null;
  }
}

export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkRenderItem[] {
  const items: ConversationAssistantWorkChildItem[] = [];
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableCuaGrouping = options?.enableCuaGrouping ?? ENABLE_CUA_TOOL_CALL_GROUPING;
  const enableProcess = options?.enableProcess ?? ENABLE_TURN_PROCESS;
  // Explore 的阶段边界和尾部状态必须基于用户实际可见的行序。等待 command 的 Shell
  // 若只在循环中跳过，仍会占据数组位置，导致前一个 Explore 被误判为已结束；
  // 隐藏 reasoning 也有相同问题。先统一剔除暂不可见行，再做配对、分组和尾部判断。
  const visibleRows = rows.filter((row) => {
    // 空文本 reasoning（Responses 加密思考无摘要、空 delta）不参与计数与分组：
    // 它没有可读内容，渲染层同样不画行；留在这里会让“思考 N 次”虚增。
    if (row.kind === "reasoning" && row.text.length === 0) {
      return false;
    }
    if (
      row.kind === "reasoning" &&
      !isConversationReasoningRowVisible(row.rowId, reasoningVisibility)
    ) {
      return false;
    }
    return !shouldDeferUnclassifiedShellToolCall(row);
  });
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(visibleRows);
  const preparedRows = prepareCuaGroups(
    visibleRows,
    enableCuaGrouping,
    options?.stageTailIsRunning === true,
  );
  let index = 0;

  while (index < preparedRows.length) {
    const row = preparedRows[index];
    if (!row) {
      index += 1;
      continue;
    }

    if (row.kind === "cuaGroup") {
      items.push(row);
      index += 1;
      continue;
    }

    // 已配对进 Agent 块的 subagent 行：不再单独渲染。
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) {
      index += 1;
      continue;
    }
    if (isToolCallRow(row)) {
      const pairedSubagent = subagentByAgentToolRowId.get(row.rowId);
      if (pairedSubagent) {
        items.push({
          kind: "agentToolCall",
          key: `agent:${row.rowId}`,
          row,
          subagentRow: pairedSubagent,
        });
        index += 1;
        continue;
      }
    }

    const isExploreRow = isExploreToolCallRow(row);
    if (!isExploreRow) {
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    if (!enableExploreGrouping) {
      items.push({
        kind: "row",
        key: `row:${row.rowId}`,
        row,
      });
      index += 1;
      continue;
    }

    const groupRows: ToolCallRow[] = [row];
    index += 1;
    while (index < preparedRows.length) {
      const nextRow = preparedRows[index];
      if (!nextRow || nextRow.kind === "cuaGroup" || !isExploreToolCallRow(nextRow)) {
        break;
      }
      groupRows.push(nextRow);
      index += 1;
    }
    // Explore 只有在出现第二个连续只读工具后才成立；首项必须立即按原工具展示。
    if (groupRows.length === 1) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      continue;
    }
    items.push(
      buildExploreGroup(
        groupRows,
        options?.stageTailIsRunning === true && index === preparedRows.length,
      ),
    );
  }

  if (!enableProcess) {
    return items;
  }
  return foldProcessRows(items, options?.stageTailIsRunning === true);
}
