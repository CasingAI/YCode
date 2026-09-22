import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { isCronAutomationCardToolCall } from "@/ToolCallBlocks/renderers/cron-create.js";
import { isOffPeakCreateToolCall } from "@/ToolCallBlocks/renderers/offpeak-create.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { isResumeWorkflowRunToolCall } from "@/lib/workflowToolNames.js";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
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
  return item.kind === "row" && isBorderedShellWorkRow(item.row);
}

/**
 * 行级判定：这行渲染出来是不是带边框外壳的独立盒子。工作项列表与 flow 容器两层
 * 间距判定共用它——带边框外壳的行不进任何过程桶、也不进分组，所以块的边缘项
 * 是不是外壳，看这条块的边缘行就够了。
 */
export function isBorderedShellWorkRow(row: AssistantWorkRow | undefined): boolean {
  if (row === undefined || row.kind !== "toolCall") {
    return false;
  }
  return isBorderedShellToolCallRow(row);
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
 * 用户气泡与相邻助手内容之间、以及工作段表头之后的行距：分界处沿用收紧前的 20px，
 * 气泡与表头（「已停止 / 工作了 N 秒」）要独立成段，不并入过程流。
 */
export const WORK_ITEM_USER_GAP_CLASS = "mt-5";
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

/**
 * flow 容器（`ConversationWorkSegmentFlow`）里一项承担的间距角色。
 *
 * `user` 是用户气泡；`defaultGap` 表示这一项**自己的**外边距交回容器默认规则
 * （20px）——只有工作段表头之后的第一个助手块是这种：表头带 `border-b` + `pb-2`，
 * 是这段工作的表格头而非过程行，其下要留 20px，否则首行会顶到分隔线上。
 * 它仍参与相邻项的判定，块边缘是不是带边框外壳照常传给下面那一项。
 */
export type ConversationFlowGapSide =
  | { kind: "user" }
  | { kind: "assistant"; shellAtStart: boolean; shellAtEnd: boolean; defaultGap: boolean };

/**
 * 把 flow 项序列换算成间距角色序列。
 *
 * 带边框外壳的块不进过程桶也不进分组，块的边缘是不是外壳看边缘行即可。
 */
export function conversationFlowGapSides(
  flowItems: readonly ConversationTurnFlowItem[],
): ConversationFlowGapSide[] {
  const firstAssistantIndex = flowItems.findIndex((item) => item.kind !== "userInput");
  return flowItems.map((item, index) => {
    if (item.kind === "userInput") {
      return { kind: "user" };
    }
    const defaultGap = index === firstAssistantIndex;
    if (item.kind === "assistantText" || item.kind === "cuaGroup") {
      return { kind: "assistant", shellAtStart: false, shellAtEnd: false, defaultGap };
    }
    return {
      kind: "assistant",
      shellAtStart: isBorderedShellWorkRow(item.rows[0]),
      shellAtEnd: isBorderedShellWorkRow(item.rows.at(-1)),
      defaultGap,
    };
  });
}

/**
 * flow 容器里相邻两项之间的纵向间距，同样挂在后一项身上、看边界**两侧**：
 * 后一项自己的间距交回默认规则（表头后的第一个助手块）→ 返回 undefined；
 * 任一侧是用户气泡 → 20px（气泡独立成段）；两侧都是助手侧内容 → 贴紧 2px，
 * 除非边界贴着带边框外壳的块边缘，那按块的 16px，与工作项列表内卡片的上下间距同值。
 *
 * 只看**后一项**要不要交回默认：表头后的第一个块自己不吃贴紧规则，但它下面那一项
 * 该怎么排就怎么排（卡片收尾的这个块后面接正文段，仍要按 16px 分开）。
 */
export function flowItemGapClass(
  index: number,
  sides: readonly ConversationFlowGapSide[],
): string | undefined {
  if (index === 0) {
    return undefined;
  }
  const current = sides[index];
  const previous = sides[index - 1];
  if (current?.kind === "assistant" && current.defaultGap) {
    return undefined;
  }
  if (current?.kind === "user" || previous?.kind === "user") {
    return WORK_ITEM_USER_GAP_CLASS;
  }
  const shellAtBoundary =
    (previous?.kind === "assistant" && previous.shellAtEnd) ||
    (current?.kind === "assistant" && current.shellAtStart);
  if (shellAtBoundary) {
    return WORK_ITEM_CARD_GAP_CLASS;
  }
  return WORK_ITEM_TIGHT_GAP_CLASS;
}

/** history 折叠外壳内层既有的上内边距：这一项交回容器默认规则（20px）时沿用。 */
export const HISTORY_CONTENT_DEFAULT_PADDING_CLASS = "pt-5";

const FLOW_GAP_PADDING_CLASS: Readonly<Record<string, string>> = {
  [WORK_ITEM_TIGHT_GAP_CLASS]: "pt-0.5",
  [WORK_ITEM_CARD_GAP_CLASS]: "pt-4",
  [WORK_ITEM_USER_GAP_CLASS]: HISTORY_CONTENT_DEFAULT_PADDING_CLASS,
};

/**
 * history 折叠外壳不能在外层挂外边距：`display:none` 前的最后一帧会把外壳高度
 * 多算一段，收起动画的终点就和展开态对不上。同一个间距换成 `pt-*` 放进动画层内部，
 * 收起时随内容一起归零。
 */
export function flowGapPaddingClass(gapClassName: string | undefined): string | undefined {
  if (gapClassName === undefined) {
    return undefined;
  }
  return FLOW_GAP_PADDING_CLASS[gapClassName];
}
