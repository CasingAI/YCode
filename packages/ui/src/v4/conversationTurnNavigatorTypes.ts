// 分享导出选择的本地目录骨架。
// 导出选择必须与已载入窗口同源（CLI 目录条目没有 productTurnId 归属），
// 因此保留一份本地行 → 条目骨架的适配器；rail 主路径走 query/directory，不经过这里。
import type { ConversationQueryDirectoryEntry } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export function buildConversationShareNavigatorEntries(
  units: readonly ConversationTurnRenderUnit[],
): ConversationQueryDirectoryEntry[] {
  return units.flatMap((unit) => {
    if (unit.timelineOnly) {
      return [];
    }
    const realUserInputs = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
    if (realUserInputs.length === 0) {
      return [];
    }
    // 分享侧只取骨架（key/rowId/turnId）：预览文案由 rail 按 kind 兜底，
    // 导出选择面板只用 rowId 归属，不读预览。
    return realUserInputs.map((row) => ({
      key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
      rowId: row.rowId,
      turnId: unit.turnId,
      userPreview: "",
      assistantPreview: "",
      assistantPreviewKind: "empty" as const,
    }));
  });
}
