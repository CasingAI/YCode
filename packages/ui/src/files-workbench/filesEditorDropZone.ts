import type { FilesEditorSplitEdge } from "@/files-workbench/filesEditorLayout.js";

export const FILES_EDITOR_SPLIT_EDGE_RATIO = 0.22;

export interface FilesEditorDropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Match the reference editor: each edge zone is 22% of that axis, not a fixed pixel band. */
export function filesEditorSplitEdgeAtPoint(
  clientX: number,
  clientY: number,
  rect: FilesEditorDropRect,
): FilesEditorSplitEdge | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;

  if (x < FILES_EDITOR_SPLIT_EDGE_RATIO) return "left";
  if (x > 1 - FILES_EDITOR_SPLIT_EDGE_RATIO) return "right";
  if (y < FILES_EDITOR_SPLIT_EDGE_RATIO) return "top";
  if (y > 1 - FILES_EDITOR_SPLIT_EDGE_RATIO) return "bottom";
  return undefined;
}
