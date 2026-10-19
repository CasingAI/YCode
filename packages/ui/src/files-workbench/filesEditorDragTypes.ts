/** Custom payload identifying a drag that originated from an editor tab. */
export const FILES_EDITOR_VIEW_DRAG_MIME = "application/x-ycode-files-editor-view";

export function isFilesEditorViewDrag(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  return Boolean(
    dataTransfer && Array.from(dataTransfer.types).includes(FILES_EDITOR_VIEW_DRAG_MIME),
  );
}

/** OS file drops must never consume the editor's internal view-drag payload. */
export function isExternalFilesDrag(
  dataTransfer: Pick<DataTransfer, "types" | "files"> | null | undefined,
): boolean {
  if (!dataTransfer || isFilesEditorViewDrag(dataTransfer)) return false;
  return Array.from(dataTransfer.types).includes("Files") || dataTransfer.files.length > 0;
}
