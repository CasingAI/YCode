// 前插块：补页（rowsRange 返回的一批行）全量进块暗处合练量真高。
//
// 为什么不再按 turnHeader 切分留 trailing：页从 turn 中段开始或页尾 turn 延续到
// 窗口首行时，trailing 行进虚拟列表走 estimateSize 先猜，猜完纠正的路又被滚动保护
// 与锚点清理同时关掉，差额永久留下——手机上几乎每页都有半轮，所以必现偏移。
// 全量进块后，拼好后的整轮（含窗口里已有的同轮前半截）在块里合练成完整一轮再翻转；
// 拼好后的高度只能量拼好后的整轮，两截相加不等于合练值（折叠、分组、展开态一合并就变）。

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export interface PendingPageSplit {
  /** 补页的全部行，按 rowId 升序；进入块容器。 */
  blockRows: readonly ConversationRow[];
  /** 不再留尾巴：恒为空，仅为调用方形状兼容保留。 */
  trailingRows: readonly ConversationRow[];
}

/**
 * 切分补页：全量进块。
 *
 * @param pendingRows rowsRange 返回的行（rowId 升序）
 * @param windowFirstRow 当前窗口首行（仅保留参数位，判定不再需要它）
 */
export function splitPendingPageIntoBlockTurns(
  pendingRows: readonly ConversationRow[],
  windowFirstRow: ConversationRow | undefined,
): PendingPageSplit {
  void windowFirstRow;
  if (pendingRows.length === 0) return { blockRows: [], trailingRows: [] };
  return { blockRows: pendingRows, trailingRows: [] };
}

/**
 * 把补页末轮在窗口里的后半截拼回补页行集。
 *
 * 为什么必须缝合：同一轮被补页与窗口切成两半时，轮头在补页、轮尾在窗口。只拿轮头
 * 建帧，那一轮就「还没有最终正文」——折叠规则（`conversationTurnRenderUnits.ts` 的
 * `assistantHistoryDefaultOpen`）读成「仍在进行」，暗处渲染成展开态；翻转成正式内容
 * 时轮尾到齐、同一节点改判收起，收起动画与内容位移一起发生（用户可见的「滚上去才
 * 收起」）。
 *
 * 缝合只在边界轮真的跨页时发生：窗口首轮与补页末轮不是同一轮时原样返回。
 *
 * @param pendingRows 补页行（rowId 升序）
 * @param windowRows 当前窗口行（rowId 升序）
 */
export function stitchPendingPageBoundaryTurn(
  pendingRows: readonly ConversationRow[],
  windowRows: readonly ConversationRow[],
): readonly ConversationRow[] {
  if (pendingRows.length === 0 || windowRows.length === 0) return pendingRows;
  const boundaryTurnId = pendingRows[pendingRows.length - 1]!.turnId;
  // 窗口里属于边界轮的行必然是首段：行按 rowId 升序、轮内连续。
  const boundaryWindowRows: ConversationRow[] = [];
  for (const row of windowRows) {
    if (row.turnId !== boundaryTurnId) break;
    boundaryWindowRows.push(row);
  }
  if (boundaryWindowRows.length === 0) return pendingRows;
  return [...pendingRows, ...boundaryWindowRows];
}
