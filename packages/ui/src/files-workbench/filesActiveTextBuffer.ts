import { isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

export function filesActiveTextBuffer(buffers: readonly FilesBuffer[], activeId?: string) {
  const buffer = buffers.find((candidate) => candidate.id === activeId);
  return buffer && isFilesTextBuffer(buffer) ? buffer : undefined;
}
