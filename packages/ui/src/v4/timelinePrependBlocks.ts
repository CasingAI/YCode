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
