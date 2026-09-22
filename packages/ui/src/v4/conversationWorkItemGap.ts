import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { isCronAutomationCardToolCall } from "@/ToolCallBlocks/renderers/cron-create.js";
import { isOffPeakCreateToolCall } from "@/ToolCallBlocks/renderers/offpeak-create.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { isResumeWorkflowRunToolCall } from "@/lib/workflowToolNames.js";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

type LegacyToolCall = ReturnType<typeof toolCallRowToLegacyNode>["toolCall"];

/**
 * 计划卡（`switch-mode`，即 ExitPlanMode）：只有拿到 plan markdown 时才渲染带边框外壳；
 * 无 markdown（失败 / 老会话）时退化成平铺输出块，按平铺行对待。
 *
 * 先认工具身份再看 markdown：`extractPlanToolCallContent` 对任何工具都可能从 input / output
 * 的 `text`、`content` 字段读出「markdown」，不先判定身份会把它当成计划卡（SendMessage 之类
 * 的 input 恰好带 text）。
 *
 * 该函数的 workspacePath 只用于把相对 planFilePath 拼成绝对路径，这里只读 markdown 有无，
 * 传空串即可。
 */
function hasPlanCardShell(toolCall: LegacyToolCall): boolean {
  return (
    resolveToolCallIdentity(toolCall).family === "switch-mode" &&
    extractPlanToolCallContent(toolCall, "").markdown !== undefined
  );
}

/**
 * 相邻工作项之间是否按「带边框外壳的块」对待——只有渲染出来是独立盒子的那一类才是。
 *
 * 判定清单必须与渲染器的最外层保持一致：`ToolLayout` 平铺行（绝大多数工具行、工具分组、
 * 子智能体、CUA 分组、`TodoWrite` 行、`CreateWorkflow` 行）都没有边框与背景，
 * 渲染成独立盒子的只有下面这几支。新增带边框外壳的卡片渲染器时要同步登记，
 * 否则它的上下间距会退回 2px 贴平。
 */
export function isBorderedShellWorkItem(item: ConversationAssistantWorkRenderItem): boolean {
  if (item.kind !== "row" || item.row.kind !== "toolCall") {
    return false;
  }
  return isBorderedShellToolCallRow(item.row);
}

/**
 * 行级判定结果按行对象缓存：间距判定在每次渲染里对每项都要跑一次，
 * 而判定要先桥接成 legacy 节点（`toolCallRowToLegacyNode` 会做输入预览与错误文本归一，
 * 比一次字符串比较重得多）。v4 投影里的行是替换而非原地修改，按引用缓存不会读到旧值。
 */
const borderedShellByRow = new WeakMap<object, boolean>();

function isBorderedShellToolCallRow(row: ToolCallRow): boolean {
  const cached = borderedShellByRow.get(row);
  if (cached !== undefined) {
    return cached;
  }
  const toolCall = toolCallRowToLegacyNode(row).toolCall;
  const result =
    isResumeWorkflowRunToolCall(toolCall) ||
    isCronAutomationCardToolCall(toolCall) ||
    isOffPeakCreateToolCall(toolCall) ||
    hasPlanCardShell(toolCall);
  borderedShellByRow.set(row, result);
  return result;
}

/** 相邻平铺项之间的行距：贴紧到一线缝。 */
export const WORK_ITEM_TIGHT_GAP_CLASS = "mt-0.5";
/** 带边框外壳的块与相邻项之间的行距：沿用收紧前的值，块要独立成一段。 */
export const WORK_ITEM_CARD_GAP_CLASS = "mt-4";
/**
 * 汇总展开内容里连续过程行的行距：与 WORK_ITEM_TIGHT_GAP_CLASS 同为 2px，
 * 只是作用域从「相邻项之间」换成 space-y（作用于容器子元素）。
 */
export const TURN_SUMMARY_CONTENT_GAP_CLASS = "space-y-0.5";

/**
 * 相邻两项之间的纵向间距挂在后一项身上：容器 gap 无法区分项类型，
 * 而需求正是「平铺行连成一片、带边框外壳的块独立成块」这两种间距并存。
 *
 * 判定必须看边界的**两侧**：只看后一项自己的类型时，卡片后面接过程汇总行或正文行
 * 会只剩贴紧态，卡片上下就不对称了（上面 16px、下面 2px）。
 *
 * 首项不加间距，否则块首会凭空多出一段空白。
 */
export function workItemGapClass(
  index: number,
  items: readonly ConversationAssistantWorkRenderItem[],
): string | undefined {
  if (index === 0) {
    return undefined;
  }
  const current = items[index];
  const previous = items[index - 1];
  if (
    (current !== undefined && isBorderedShellWorkItem(current)) ||
    (previous !== undefined && isBorderedShellWorkItem(previous))
  ) {
    return WORK_ITEM_CARD_GAP_CLASS;
  }
  return WORK_ITEM_TIGHT_GAP_CLASS;
}
