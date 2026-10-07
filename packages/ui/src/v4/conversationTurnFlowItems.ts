import type {
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { extractPlanToolCallContent, hasPlanCardContent } from "@/lib/planToolCall.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

export type AssistantWorkRow = Exclude<ConversationRow, TurnHeaderRow | UserInputRow>;

export type ConversationTurnFlowItem =
  | { kind: "userInput"; row: UserInputRow }
  | { kind: "assistantHistory"; rows: AssistantWorkRow[] }
  | { kind: "assistantText"; row: AssistantTextRow; latest: boolean }
  | { kind: "assistantWork"; rows: AssistantWorkRow[] }
  /**
   * 脱流后留在原位的紧凑 CreatePlan 调用记录。
   * 与 `planCard` 用类型区分「这里调用过」和「计划内容在轮末」，不引入任何全局标记。
   */
  | { kind: "planCallRecord"; row: ToolCallRow }
  /** 从原位脱流到段末的完整计划卡。 */
  | { kind: "planCard"; row: ToolCallRow }
  | ConversationCuaGroupRenderItem;

/**
 * 这一行渲染出来是不是一张完整的计划卡（带边框外壳）。
 *
 * 先认工具身份再判内容：`extractPlanToolCallContent` 对任何工具都可能从 input / output 的
 * `text`、`content` 字段读出「markdown」，不先判定身份会把它当成计划卡（SendMessage 之类的
 * input 恰好带 text）。内容判据与渲染器的 `shouldRenderCollapsedPlanCard` 同源（title /
 * overview / markdown 任一在场即成卡），所以流式期只有 title/overview 的半截计划也算卡。
 *
 * workspacePath 只用于把相对 planFilePath 拼成绝对路径，这里只读内容有无，传空串即可。
 *
 * 这份判据必须与 `conversationWorkItemGap` 的卡片间距判定保持一致：那里按它决定 16px
 * 卡片间距，这里按它决定要不要脱流，两处漂移就会出现「卡片按壳排版、却仍被收进过程桶」。
 */
export function isPlanCardToolCallRow(row: AssistantWorkRow | undefined): row is ToolCallRow {
  if (row?.kind !== "toolCall") {
    return false;
  }
  const toolCall = toolCallRowToLegacyNode(row).toolCall;
  return (
    resolveToolCallIdentity(toolCall).family === "switch-mode" &&
    hasPlanCardContent(extractPlanToolCallContent(toolCall, ""))
  );
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function appendGroupedAssistantFlowItem(
  items: ConversationTurnFlowItem[],
  kind: "assistantHistory" | "assistantWork",
  row: AssistantWorkRow,
): void {
  const previous = items.at(-1);
  if (previous?.kind === kind) {
    previous.rows.push(row);
    return;
  }
  items.push({ kind, rows: [row] });
}

/**
 * 该段里最后一条真正参与 flow 的助手行（轮尾 boundary 已拆走，不算）。
 *
 * 脱流判定要拿它当「计划行本来是不是就在末尾」的标尺：Plan 档 `CreatePlan` 一成功就
 * `plan_created` 停轮，这条行就是段末，脱流不触发，从根上杜绝「调用记录 + 完整卡」重复渲染。
 */
function resolveLastSegmentFlowRowId(
  orderedRows: readonly ConversationRow[],
  tailRowIds: ReadonlySet<number>,
): number | undefined {
  let lastRowId: number | undefined;
  for (const row of orderedRows) {
    if (!isAssistantWorkRow(row) || tailRowIds.has(row.rowId)) continue;
    lastRowId = row.rowId;
  }
  return lastRowId;
}

/**
 * 本气泡最后一次模型响应的身份：段内最后一条非 tail 助手工作行携带的 assistantResponseId。
 *
 * 一次模型请求产出一条助手响应，这次响应产出的正文 / 思考 / 工具行共享同一个
 * assistantResponseId（见 rows.ts 的行级注释）。段内最后一条助手工作行必然属于最后一次
 * 响应，拿它当「最后一个 turn」的锚点，脱流判据就完全落在本气泡内部——不看这条会话里
 * 它是不是最后一轮，也不受后到消息影响。
 */
function resolveTurnLastResponseId(
  orderedRows: readonly ConversationRow[],
  tailRowIds: ReadonlySet<number>,
): string | undefined {
  let lastResponseId: string | undefined;
  for (const row of orderedRows) {
    if (!isAssistantWorkRow(row) || tailRowIds.has(row.rowId)) continue;
    // 最后一条行缺 id（旧 snapshot、timelineOnly）就取不到锚点：改取更早行的 id 会把
    // 「上一次响应」冒充成「最后一次」，宁可留 undefined 让脱流失败向安全侧倒。
    lastResponseId = "assistantResponseId" in row ? row.assistantResponseId : undefined;
  }
  return lastResponseId;
}

export function buildConversationFlowItems(options: {
  orderedRows: readonly ConversationRow[];
  assistantHistoryRows: readonly AssistantWorkRow[];
  assistantFollowingRows: readonly AssistantWorkRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  /** 当前 visual work segment 外置展示的末段正文。 */
  visibleAssistantTextRow?: AssistantTextRow;
  /** 整个 product turn 唯一可挂 action 的最终正文。 */
  latestAssistantTextRow?: AssistantTextRow;
  timelineOnly: boolean;
}): ConversationTurnFlowItem[] {
  const historyRowIds = new Set(options.assistantHistoryRows.map((row) => row.rowId));
  const followingRowIds = new Set(options.assistantFollowingRows.map((row) => row.rowId));
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  const items: ConversationTurnFlowItem[] = [];

  // 脱流只留给本气泡最后一个 turn 产出的计划卡：一次模型请求 = 一条助手响应，行上的
  // assistantResponseId 就是这次响应的身份。计划行不在这最后一次响应里（其后还有别的
  // 响应产出的行）就随过程折叠，不在原位留孤儿小字行、也不在段末重复出卡。「最后一个
  // turn」只在气泡内部计算，点「执行计划」发新消息开的是新气泡，旧气泡的判据不变，
  // 前面的显示不因此变化；缺 id 的行证不出归属，一律不脱流。
  const lastSegmentFlowRowId = resolveLastSegmentFlowRowId(options.orderedRows, tailRowIds);
  const turnLastResponseId = resolveTurnLastResponseId(options.orderedRows, tailRowIds);
  const detachedPlanCards: ToolCallRow[] = [];

  for (const row of options.orderedRows) {
    if (isUserInputRow(row)) {
      items.push({ kind: "userInput", row });
      continue;
    }
    if (!isAssistantWorkRow(row)) continue;
    // 轮尾 boundary 已从 assistant flow 拆成 assistantTailRows；若再把它追加回
    // flowItems，renderer 会把它渲染在定时任务卡片、文件 summary 和消息操作栏之前。
    // 这里只保留真实 flow；boundary 由 TurnGroup 在全部 turn-local 附属 UI 之后统一收尾。
    if (tailRowIds.has(row.rowId)) continue;
    if (
      isAssistantTextRow(row) &&
      (row.rowId === options.visibleAssistantTextRow?.rowId || !historyRowIds.has(row.rowId)) &&
      !followingRowIds.has(row.rowId) &&
      !tailRowIds.has(row.rowId) &&
      !options.timelineOnly
    ) {
      items.push({
        kind: "assistantText",
        row,
        latest: row.rowId === options.latestAssistantTextRow?.rowId,
      });
      continue;
    }
    // 只有本气泡最后一次响应产出的计划卡才脱流：同一次响应里排在计划行之后的工具行会把
    // 它挤出段末，这里把计划行摘成原位的紧凑调用记录，完整卡片统一在段末渲染；更早响应
    // 产出的计划行不走这条路，随过程行一起进折叠桶。
    if (
      isPlanCardToolCallRow(row) &&
      row.rowId !== lastSegmentFlowRowId &&
      row.assistantResponseId !== undefined &&
      row.assistantResponseId === turnLastResponseId
    ) {
      items.push({ kind: "planCallRecord", row });
      detachedPlanCards.push(row);
      continue;
    }
    appendGroupedAssistantFlowItem(
      items,
      historyRowIds.has(row.rowId) && !options.timelineOnly ? "assistantHistory" : "assistantWork",
      row,
    );
  }

  // 段末按原相对顺序补回完整卡片：多个计划调用也要保持彼此的先后。
  for (const row of detachedPlanCards) {
    items.push({ kind: "planCard", row });
  }

  return items;
}
