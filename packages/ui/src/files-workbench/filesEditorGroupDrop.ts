import type { DragEvent } from "react";
import type { FilesEditorSplitEdge } from "@/files-workbench/filesEditorLayout.js";
import { filesEditorSplitEdgeAtPoint } from "@/files-workbench/filesEditorDropZone.js";

/** 编辑器组拖拽命中：标签栏上的拖动留给标签排序，不参与分屏。 */
export function filesEditorDropEdgeAtEvent(
  event: DragEvent<HTMLDivElement>,
): FilesEditorSplitEdge | undefined {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('[role="tablist"]')) return undefined;
  const rect = event.currentTarget.getBoundingClientRect();
  return filesEditorSplitEdgeAtPoint(event.clientX, event.clientY, rect);
}

export function filesEditorDropOverlayClass(edge: FilesEditorSplitEdge): string {
  switch (edge) {
    case "left":
      return "inset-y-0 left-0 w-1/2 border-r-2";
    case "right":
      return "inset-y-0 right-0 w-1/2 border-l-2";
    case "top":
      return "inset-x-0 top-0 h-1/2 border-b-2";
    case "bottom":
      return "inset-x-0 bottom-0 h-1/2 border-t-2";
  }
}
