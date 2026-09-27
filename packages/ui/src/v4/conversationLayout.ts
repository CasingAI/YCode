import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";

const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
const CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
const CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
const CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME =
  "@min-[1280px]/conversation:-translate-x-42";

type ConversationStatusPanelResolvedVariant = ChatViewSummaryPanelVariant | "auto";

export function getConversationContentWidthClassName(params: {
  centeredEmptyLayout: boolean;
  statusPanelLayout: "none" | "auto" | "inline";
}): string {
  if (params.centeredEmptyLayout) return CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME;

  // 宽布局统一使用 1280px，避免面板状态变化时触发不同断点造成内容列跳变。
  return params.statusPanelLayout === "none"
    ? CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME
    : CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME;
}

export function resolveConversationStatusPanelVariant(params: {
  variantOverride: ConversationStatusPanelResolvedVariant | null;
}): ConversationStatusPanelResolvedVariant {
  // 自动模式必须保留到 DOM，由 conversation container query 裁决实际形态；
  // React 不再通过 ResizeObserver 把容器宽度翻译成业务状态。
  return params.variantOverride ?? "auto";
}

export function shouldUseConversationStatusPanelInlineLayout(params: {
  hasContent: boolean;
  variant: ConversationStatusPanelResolvedVariant;
}): boolean {
  return params.hasContent && params.variant !== "mini";
}

/**
 * 状态面板内部浮层的弹出方向。
 *
 * 宽视口保持向左：面板右侧锚定，左侧是会话列的富余空间，向左弹不会压住面板自身。
 * 窄视口下面板是覆盖层，占掉 `100vw - 336px`，左侧只剩一条点不到的窄缝；而 Radix
 * 的 `shift` 只会把浮层拉回视口内、不会把它挪到面板上方，于是浮层被自己的面板盖住，
 * 屏幕左缘只剩一条残片。因此窄视口一律向下弹。
 */
export function resolveConversationStatusPanelPopoverSide(params: {
  isNarrowViewport: boolean;
}): "bottom" | "left" {
  return params.isNarrowViewport ? "bottom" : "left";
}

/**
 * 折叠 Todo 分组（`已完成 N 项` / `待处理 N 项`）的预览呈现方式。
 *
 * 窄视口返回 `inline`：那里不存在可用的悬浮落点。面板贴着视口上沿，浮层向下放不下
 * 就会向上翻转，于是整块糊在屏幕顶端、盖住应用头部；改判向左则被面板自己盖住，只剩
 * 一条残片。就地展开没有落点问题——触发行的 `open` 本来就是披露语义，展开内容直接
 * 落进面板已有的滚动区，位置始终贴着用户点的那一行。
 */
export function resolveConversationTodoGroupPresentation(params: {
  isNarrowViewport: boolean;
}): "inline" | "floating" {
  return params.isNarrowViewport ? "inline" : "floating";
}

/** 折叠 Todo 分组触发行上的箭头方向：`left` 指向悬浮浮层的落点，`right`/`down` 指向就地展开的方向。 */
export type TodoPreviewChevron = "down" | "left" | "right";

/**
 * 折叠 Todo 分组触发行该显示哪个箭头。
 *
 * 悬浮形态恒为 `left`：浮层就是从触发行左边弹出来的，箭头指向的确实是它出现的位置，
 * 桌面观感不能变。
 *
 * 就地展开形态按展开状态在 `right` / `down` 之间切换，和同文件 `StatusSectionHeader`
 * 的分区标题同一套画法（收起 ›、展开 ⌄）。就地展开是往下铺开，用左箭头既指错了方向，
 * 展开后图标还纹丝不动、看不出这一组是开着的。
 */
export function resolveTodoPreviewChevron(params: {
  presentation: "inline" | "floating";
  open: boolean;
}): TodoPreviewChevron {
  if (params.presentation === "floating") {
    return "left";
  }
  return params.open ? "down" : "right";
}

export type ConversationStatusPanelSectionKind =
  | "environment"
  | "goal"
  | "sessionPlans"
  | "plan"
  | "terminal"
  | "workflow"
  | "agent";

/** 宽视口下每个分区自己的滚动视口上限；`null` 表示不限高、随卡片一起滚。 */
const CONVERSATION_STATUS_PANEL_WIDE_SECTION_SCROLL_POLICY = {
  environment: null,
  goal: "max-h-48",
  sessionPlans: "max-h-48",
  // 六个双行 Todo（6 × 52px）需要约 20rem；超过后只滚动进程区块。
  plan: "max-h-80",
  terminal: "max-h-48",
  // workflow 行与 terminal / agent 行同高（两行 + 控制），限高沿用同一档。
  workflow: "max-h-48",
  agent: "max-h-48",
} as const satisfies Record<ConversationStatusPanelSectionKind, string | null>;

/**
 * 分区内容要不要套一层自己的滚动视口。
 *
 * 宽视口保留原有限高：分区并排时各自限高，滚一个分区不会带着其余分区一起动。
 *
 * 窄视口返回 `null`，即全部汇进卡片唯一那个滚动容器。卡片本身已经由
 * `max-h-[min(64dvh,32rem)]` + 内部 `flex-1 overflow-y-auto` 兜住，永远不出屏；
 * 分区再各自限高只会切出最多六个嵌套滚动区，列表在窄的子视口里被拦腰截断，
 * 而触摸设备的滚动条只在滚动中浮现，用户看不出那里还能滚——表现就是"显示不下、
 * 又没地方可滚"。
 */
export function resolveStatusSectionScrollViewportClassName(params: {
  isNarrowViewport: boolean;
  section: ConversationStatusPanelSectionKind;
}): string | null {
  if (params.isNarrowViewport) {
    return null;
  }
  return CONVERSATION_STATUS_PANEL_WIDE_SECTION_SCROLL_POLICY[params.section];
}

export function getConversationStatusPanelOffsetClassName(
  layout: "none" | "auto" | "inline",
): string | undefined {
  // 状态面板和会话宽布局统一在 1280px 启用，保证面板状态切换不改变响应分水岭。
  return layout === "none" ? undefined : CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME;
}
