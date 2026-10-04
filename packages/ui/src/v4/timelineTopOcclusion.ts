// 桌面顶栏避让：轮顶视觉节奏与跳转落点补偿的公共口径（纯函数，无 DOM/React 依赖）。
//
// 为什么单独成文件：顶栏避让量此前寄生在轮顶 `pt-14` 里，一个数值同时干「视觉分段」
// 和「跳转不被顶栏盖住」两件事，压不下去。这里的职责是把两件事拆开——轮顶 padding
// 只管视觉节奏，跳转路径显式减这个常量。
//
// 为什么是固定 56 而不是从 DOM 实测：DesktopTopOverlay 是 `absolute left-0 top-0 z-20`
// 的覆盖层，不是占位块，滚动容器里没有任何对应节点。要实测就得再加一个 ResizeObserver
// 盯着它，而这一层与折叠触发器 `scroll-mt-14` 一样早就选了固定高度口径，改成实测会
// 让两条避让路径的数值来源分裂。

import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";

/** 桌面顶栏高度，同时也是跳转落点必须让出的最小距离。对齐 `DesktopTopOverlay` 的 `h-14`。 */
export const TIMELINE_TOP_OCCLUSION_PX = 56;

/** 轮顶 padding 的三态。首轮顶到顶栏区，其余轮只需要视觉分段。 */
const TURN_TOP_PADDING_PX = {
  startsTimeline: 56,
  workflowNotificationCard: 0,
  default: 24,
} as const;

export interface ResolveTurnTopPaddingInput {
  /** 该轮是否是会话首轮（turn 列表下标 0），由 render unit 的位置派生字段给出。 */
  startsTimeline: boolean;
  /** 该轮是否以 workflow 通知卡开头。 */
  startsWithWorkflowNotificationCard: boolean;
}

/**
 * 该轮是否以 workflow 通知卡开头。后台结果轮没有可见 user 行，通知卡就是轮内第一个
 * 节点，轮顶 padding 归零。
 *
 * 渲染侧（`ConversationTurnGroup`）和跳转侧（`ConversationTimeline`）必须读同一个判定：
 * 两边一旦漂移，跳转补偿就会按错误的 padding 算出偏移，落点被顶栏盖住或留出空洞。
 */
export function turnStartsWithWorkflowNotificationCard(header: TurnHeaderRow | undefined): boolean {
  if (header?.origin !== "backgroundResult") return false;
  return (
    header.originMeta?.backgroundSource === "workflow" &&
    header.originMeta.workflowNotification !== undefined
  );
}

/**
 * 轮顶 padding 的像素值。首轮 56px 保留顶栏避让，其余轮 24px 只做视觉分段。
 * 跳转落点由 {@link resolveJumpOcclusionOffsetPx} 单独补，这里不重复承担。
 */
export function resolveTurnTopPaddingPx({
  startsTimeline,
  startsWithWorkflowNotificationCard,
}: ResolveTurnTopPaddingInput): number {
  if (startsWithWorkflowNotificationCard) return TURN_TOP_PADDING_PX.workflowNotificationCard;
  if (startsTimeline) return TURN_TOP_PADDING_PX.startsTimeline;
  return TURN_TOP_PADDING_PX.default;
}

/** {@link resolveTurnTopPaddingPx} 的 class 形态，供轮 `<section>` 直接挂载。 */
export function resolveTurnTopPaddingClass(input: ResolveTurnTopPaddingInput): string {
  if (input.startsWithWorkflowNotificationCard) return "pt-0";
  if (input.startsTimeline) return "pt-14";
  return "pt-6";
}

/**
 * 跳转落点相对「容器顶边对齐」还要额外下移多少，目标轮的首行才不被顶栏盖住。
 *
 * `scrollToIndex({ align: "start" })` 与手算裸 top 都把落点顶边直接对齐滚动容器顶边，
 * 而顶栏是覆盖层，所以必须显式补。轮顶 padding 越大，需要补的越少：首轮自带 56px 避让，
 * 补 0；workflow 通知卡轮 `pt-0`，补满 56px。夹到 0 是为了让「padding 超过顶栏高度」
 * 这类情况不会反向把落点往上推。
 */
export function resolveJumpOcclusionOffsetPx(input: ResolveTurnTopPaddingInput): number {
  return Math.max(0, TIMELINE_TOP_OCCLUSION_PX - resolveTurnTopPaddingPx(input));
}
