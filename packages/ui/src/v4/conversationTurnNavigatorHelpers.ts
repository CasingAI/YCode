// rail 目录项的最小 render 粒度：CLI query/directory 条目直转渲染项，
// UI 只做空摘要本地化兜底与 running 叠加。本地行 → 条目骨架的适配器
// （分享导出选择用）见 conversationTurnNavigatorTypes.ts。
import type { ConversationQueryDirectoryEntry } from "@zcode/shared/zcode-protocol-v4";

// rail 渲染项：目录条目 + running 叠加态。unitIndex 是旧渲染派生物，已随
// 目录侧信道移除——跳转与高亮只用稳定 row 身份（rowId）与 turn 容器（turnId）。
export type ConversationTurnNavigatorAssistantPreviewKind = "empty" | "running" | "text";

// 分享选择面板全量补齐（projectionStore.loadAllOlder）的结果类型。
// rail 已常开且不再全量水合，这个类型只剩分享导出选择这一条消费路径，
// 用于终态缓存标注；补完分享侧实现时按实际语义收敛状态集。
export type ConversationShareHydrationResult =
  | { status: "hydrated"; logEpoch: string }
  | { status: "not-enough-queries"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
  /** 所属 product turn 容器（= unit.key = turnId）。active 判定按 turn 挂目录项。 */
  turnId?: string;
}

interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
  /**
   * 视口最上方那一行（任意 kind）的 rowId，缺省表示没有挂载行可依据。
   *
   * 这是 active 的**主**判据：目录按 rowId 升序即时间序，取「rowId ≤ topmostRowId
   * 的最后一条」就是位置上真正最近的那一问。它不依赖 turnId 映射，因此对「窗口里
   * 的轮与目录条目没有共同成员」免疫——尾窗只有最后一轮、而那一轮没有 realUser
   * query 时（实测形态），turnId 映射全线落空，只有时序判据还能给出正确答案。
   */
  topmostRowId?: number;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
}

/**
 * CLI 目录条目 → rail 渲染项。UI 只做两件事：
 * 1. 空摘要的本地化兜底（CLI 传空串，kind 区分 empty/running/text）；
 * 2. running 强调叠加：CLI 侧的 running 判定基于投影 turnHeader，renderer 用
 *    当前窗口的实时 running 集合覆盖——流式进行中的轮在目录取数之后才开始跑时，
 *    rail 不必等下一次目录重取就能点亮。
 */
export function buildConversationTurnNavigatorItems(
  entries: readonly ConversationQueryDirectoryEntry[],
  options: BuildConversationTurnNavigatorItemsOptions,
  runningRowIds?: ReadonlySet<number>,
): ConversationTurnNavigatorItem[] {
  return entries.map((entry) => {
    const isRunning =
      runningRowIds !== undefined
        ? runningRowIds.has(entry.rowId)
        : entry.assistantPreviewKind === "running";
    return {
      key: entry.key,
      turnId: entry.turnId,
      rowId: entry.rowId,
      userPreview: entry.userPreview === "" ? options.userFallbackPreview : entry.userPreview,
      assistantPreview:
        entry.assistantPreview === ""
          ? entry.assistantPreviewKind === "running"
            ? options.assistantRunningPreview
            : options.assistantEmptyPreview
          : entry.assistantPreview,
      assistantPreviewKind: entry.assistantPreviewKind,
      isRunning,
    };
  });
}

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex({
  items,
  virtualItems,
  scrollOffsetPx,
  viewportHeightPx,
  topmostRowId,
}: ResolveConversationTurnNavigatorActiveUnitIndexOptions): string | undefined {
  if (items.length === 0) {
    return undefined;
  }

  // 目录按 rowId 升序即时间序（buildConversationQueryDirectoryEntries 按 unitOrder
  // 产出，unitOrder 来自投影全量行的行序）。取「rowId ≤ topmostRowId 的最后一条」
  // 得到的就是位置上最近的那一问，**不要求那一轮出现在窗口里、也不要求 turnId 对得上**。
  if (topmostRowId !== undefined && Number.isFinite(topmostRowId)) {
    let chronologicalIndex = -1;
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]!.rowId <= topmostRowId) {
        chronologicalIndex = index;
      } else {
        break;
      }
    }
    // 视口在第一条 query 之前：还没有「最近的一问」，取首条。
    return items[chronologicalIndex >= 0 ? chronologicalIndex : 0]?.turnId;
  }

  // 没有挂载行可依据（窗口刚换、DOM 尚未提交）：退到 turn 容器映射。
  // unit.key === turnId（见 conversationTurnUnitDrafts.ts:72），virtualItems 携带
  // turnId 后可视 turn 直接映射到所属 turn 的首个目录项。
  const firstIndexByTurnId = new Map<string, number>();
  items.forEach((item, index) => {
    if (!firstIndexByTurnId.has(item.turnId)) {
      firstIndexByTurnId.set(item.turnId, index);
    }
  });
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeItemIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  let nearestItemIndex: number | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const itemIndex =
      virtualItem.turnId === undefined ? undefined : firstIndexByTurnId.get(virtualItem.turnId);
    if (itemIndex === undefined) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    // 第二遍的候选：不限视口，按到视口顶的距离排序。没有 query 的轮（goal 续写、
    // 中枢直接启动等）不在目录里，停在这样一轮上时可视区可能一个目录项都映射不到，
    // 只能靠它把 active 拉回位置上真正最近的那一条。
    const distance = Math.abs(rowStart - viewportStart);
    if (distance < nearestDistance) {
      nearestItemIndex = itemIndex;
      nearestDistance = distance;
    }
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart = rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeItemIndex = itemIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeItemIndex !== undefined) {
    return items[activeItemIndex]?.turnId;
  }

  // 可视区没有目录项，但窗口里有：取位置上最近的一条。
  if (nearestItemIndex !== undefined) {
    return items[nearestItemIndex]?.turnId;
  }

  // 整个窗口都没有目录项（目录与窗口完全错位）：仍以首条兜底，保证 rail 至少有一项高亮。
  return items[0]?.turnId;
}

export function resolveConversationTurnNavigatorActiveQueryRowId({
  positions,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveQueryRowIdOptions): number | undefined {
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  const normalized = positions
    .map((position) => {
      const start = resolveFiniteNonNegative(position.start);
      return {
        rowId: position.rowId,
        start,
        end: Math.max(start, resolveFiniteNonNegative(position.end)),
      };
    })
    .sort((left, right) => left.start - right.start || left.rowId - right.rowId);

  const visible = normalized.filter(
    (position) => position.end >= viewportStart && position.start <= viewportEnd,
  );
  if (visible.length > 0) {
    return visible.reduce((nearest, candidate) =>
      Math.abs(candidate.start - viewportStart) < Math.abs(nearest.start - viewportStart)
        ? candidate
        : nearest,
    ).rowId;
  }

  return (
    normalized.findLast((position) => position.start <= viewportStart)?.rowId ??
    normalized.find((position) => position.start > viewportStart)?.rowId
  );
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}
