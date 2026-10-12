import { getMediaPreviewFormat } from "@zcode/shared";
import { getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { isPdfPreviewPath, isPptxPreviewPath } from "@/lib/codeViewer.js";
import type { FilesBufferKind } from "@/files-workbench/filesEditorTypes.js";

export function resolveFilesBufferKind(path: string): FilesBufferKind {
  if (getMediaPreviewFormat(path)) {
    return "preview";
  }
  if (isPdfPreviewPath(path) || isPptxPreviewPath(path) || getOfficeFilePreviewKind(path)) {
    return "preview";
  }
  return "text";
}
