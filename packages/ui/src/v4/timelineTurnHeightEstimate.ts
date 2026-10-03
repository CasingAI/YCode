// 虚拟滚动核心：turn 高度结构化估算（纯函数，无 DOM/React 依赖）。
//
// 为什么需要它：虚拟化粒度是 turn 而非单条消息，一个 turn 里装着用户输入、
// 可能上千 px 的最终正文，以及成百上千条 toolcall。未测量行此前统一回落到
// DEFAULT_ROW_HEIGHT_ESTIMATE_PX(72)——那是「一行消息」时代的常量，与实测
// 平均 ~372px 差 5 倍量级。首屏期间这些 turn 逐个被 measureElement 真实测量，
// totalSize 持续暴涨，任何基于高度差的滚动锚点补偿都只是在追一个不断移动的
// 目标。这就是长历史里位置漂移和闪现的直接来源。
//
// 估算按「会渲染出多少高度」算，而不是按「有多少行」算：
// - 折叠的 history 在 Radix Presence 关闭时不挂载子 DOM，DOM 上只剩一个触发按钮，
//   所以里面的 toolcall 数量不参与高度（这是折叠态最重要的性质）；
// - 展开的 history 还要再过一遍过程折叠，连续的
//   explore/terminal/changes/reasoning 会收成一行，所以按「连续可折叠段」计数，
//   不能按原始行数计数，否则一屏全是终端输出的轮会被高估一个数量级。
//
// 字符高度依赖内容宽度。正文列宽由 conversationLayout.ts 的 container query 固定
// （864px 断点 max-w-4xl = 896px，1280px 断点 max-w-6xl = 1152px），基准字号
// 14px（--ui-font-size）。下面的 CHARS_PER_LINE 按 896px 列 + 中文全角标定；
// 改 conversationLayout 的断点时要一并复核这个常量。

import {
  isChangesToolCallRow,
  isExecuteToolCallRow,
  isExploreToolCallRow,
} from "@/v4/conversationToolRowClass.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

/** 用户气泡：头像 + 若干行正文 + 气泡内边距。 */
const USER_INPUT_PX = 56;
/** 折叠 history 的可见高度：一个边框行 + 一个触发按钮。 */
const COLLAPSED_HISTORY_PX = 40;
/** 展开 history 里单条过程行（工具摘要行）的高度。 */
const WORK_ROW_PX = 32;
/** 连续的 explore/terminal/changes/reasoning 收成过程行后的高度。 */
const FOLDED_SUMMARY_RUN_PX = 32;
/** CUA 分组自身的折叠触发行。 */
const CUA_GROUP_TRIGGER_PX = 40;
/** 轮顶轻边界（modelChange）分隔。 */
const LEADING_BOUNDARY_PX = 12;
/** 轮尾 boundary / artifact 行。 */
const TAIL_ROW_PX = 20;
/** turn-local hook 详情卡。 */
const HOOK_CARD_PX = 36;
/** Browser 自动轮尾截图。 */
const BROWSER_TURN_END_IMAGE_PX = 240;
/** 中枢直接启动轮的 run 卡。 */
const WORKFLOW_LAUNCH_CARD_PX = 120;
/** 计划卡的固定外壳：头部「计划」标签、标题与概述、底部查看/执行两个按钮。 */
const PLAN_CARD_CHROME_PX = 120;
/** 全文预览形态的计划卡把正文裁在 max-h-64（256px）里，估算不得越过这个上限。 */
const PLAN_CARD_PREVIEW_MAX_PX = 256;
/** 轮内相邻 flow item 之间的间距。 */
const FLOW_ITEM_GAP_PX = 8;

/** 正文单行高度：14px 基准字号 × 1.5 行高，留一点段间距余量。 */
const TEXT_LINE_PX = 22;
/** 896px 内容列下的每行字符数（全角中文最坏情况）。 */
const CHARS_PER_LINE = 64;
/** 单条正文封顶行数：防止超长回复把单个 turn 的估算撑爆，破坏滚动条比例。 */
const TEXT_MAX_LINES = 400;

/** 估算下界：任何 turn 至少渲染出用户气泡或一行工作状态。 */
const MIN_ESTIMATE_PX = 48;
/**
 * 估算上界：单个 turn 再大也不该超过这个数。虚拟器用 totalSize 决定滚动条比例，
 * 一个估算失控的巨轮就能让整条时间线的滚动条失真。展开的巨轮由真实测量接管，
 * 上界只保证「测量到达之前」的比例不至于崩。
 */
export const MAX_TURN_ESTIMATE_PX = 20000;

function estimateTextHeight(text: string | undefined): number {
  if (!text || text.length === 0) return TEXT_LINE_PX;
  const lines = Math.min(Math.ceil(text.length / CHARS_PER_LINE), TEXT_MAX_LINES);
  return lines * TEXT_LINE_PX;
}

/** 与 conversationProcessFold.resolveProcessBucket 同源的折叠判定。 */
function isFoldableSummaryRow(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning") return true;
  if (row.kind !== "toolCall") return false;
  return isExploreToolCallRow(row) || isExecuteToolCallRow(row) || isChangesToolCallRow(row);
}

/**
 * 展开态过程区的高度：连续可折叠行收成一行，其余按单行计。
 * 与 foldProcessRows 的分段规则一致——被非可折叠行隔断的段各自独立起一行。
 */
function estimateWorkRowsHeight(rows: readonly AssistantWorkRow[]): number {
  let height = 0;
  let inFoldedRun = false;
  for (const row of rows) {
    if (isFoldableSummaryRow(row)) {
      if (inFoldedRun) continue;
      inFoldedRun = true;
      height += FOLDED_SUMMARY_RUN_PX;
      continue;
    }
    inFoldedRun = false;
    height += WORK_ROW_PX;
  }
  return height;
}

/**
 * 脱流到轮末的完整计划卡：有概述时走折叠形态（只露标题与概述，正文不进高度），
 * 缺概述的旧计划走全文预览形态，正文按 max-h-64 裁切后估。
 *
 * workspacePath 只用于把相对 planFilePath 拼成绝对路径，这里只读正文长度，传空串即可
 * （`conversationWorkItemGap` 的卡片判据也是这么调的）。
 */
function estimatePlanCardHeight(row: ToolCallRow): number {
  const { markdown, overview } = extractPlanToolCallContent(
    toolCallRowToLegacyNode(row).toolCall,
    "",
  );
  if (overview !== undefined) {
    return PLAN_CARD_CHROME_PX;
  }
  return PLAN_CARD_CHROME_PX + Math.min(estimateTextHeight(markdown), PLAN_CARD_PREVIEW_MAX_PX);
}

function estimateFlowItemHeight(item: ConversationTurnFlowItem, historyOpen: boolean): number {
  switch (item.kind) {
    case "userInput":
      return USER_INPUT_PX;
    case "assistantText":
      return estimateTextHeight(item.row.text);
    // 折叠态只看得到触发按钮，展开态才按内容估——这一条是长历史里最省的分支。
    case "assistantHistory":
      return historyOpen ? estimateWorkRowsHeight(item.rows) : COLLAPSED_HISTORY_PX;
    case "assistantWork":
      return estimateWorkRowsHeight(item.rows);
    // 原位留下的紧凑 CreatePlan 调用记录就是一条 ToolLayout 平铺行。
    case "planCallRecord":
      return WORK_ROW_PX;
    // 轮末的完整计划卡：漏掉这一支会被下面的 default 当 cuaGroup 估，
    // 虚拟列表在含计划卡的末轮上就会按触发行的高度滚动，跳动和错位都出在这里。
    case "planCard":
      return estimatePlanCardHeight(item.row);
    default:
      return historyOpen
        ? CUA_GROUP_TRIGGER_PX + estimateWorkRowsHeight(item.rows)
        : CUA_GROUP_TRIGGER_PX;
  }
}

function estimateFlowItemsHeight(
  flowItems: readonly ConversationTurnFlowItem[],
  historyOpen: boolean,
): number {
  let height = 0;
  for (const item of flowItems) {
    height += estimateFlowItemHeight(item, historyOpen) + FLOW_ITEM_GAP_PX;
  }
  return height;
}

/**
 * 未测量 turn 的高度估算。缓存命中优先（见 TimelineRowHeightCache.estimate），
 * 本函数只负责「还没有测过」的那部分。
 */
export function estimateConversationTurnHeight(
  unit: ConversationTurnRenderUnit | undefined,
): number {
  if (!unit) return MIN_ESTIMATE_PX;

  let height = unit.workflowLaunch ? WORKFLOW_LAUNCH_CARD_PX : 0;
  height += unit.leadingBoundaryRows.length * LEADING_BOUNDARY_PX;

  // 按段估：每个工作段的 history 开合状态是独立的，用 turn 级的
  // assistantHistoryDefaultOpen 会把展开段算成折叠（或反过来）。
  const segments = unit.workSegments;
  if (segments && segments.length > 0) {
    for (const segment of segments) {
      height += estimateFlowItemsHeight(segment.flowItems, segment.assistantHistoryDefaultOpen);
    }
  } else {
    height += estimateFlowItemsHeight(unit.flowItems, unit.assistantHistoryDefaultOpen);
  }

  height += unit.assistantTailRows.length * TAIL_ROW_PX;
  height += unit.browserTurnEndRows.length * BROWSER_TURN_END_IMAGE_PX;
  height += unit.hookInvocations.length * HOOK_CARD_PX;
  return Math.min(Math.max(height, MIN_ESTIMATE_PX), MAX_TURN_ESTIMATE_PX);
}
