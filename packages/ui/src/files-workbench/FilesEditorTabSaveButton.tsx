import { Save } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  canSaveFilesBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 标签栏上的保存按钮。
 *
 * 与菜单、快捷键共用同一条写盘路径（都落到控制器的 saveTextBuffer），
 * 按钮本身只负责「当前标签能不能保存」。
 */
export function FilesEditorTabSaveButton({
  activeBuffer,
  onSave,
}: {
  activeBuffer: FilesBuffer | undefined;
  onSave?: (bufferId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 只读预览、只读大文本与旧截断文本没有可写路径，不出现保存按钮；
  // 没有未保存改动时也不出现。
  const canSave = Boolean(
    activeBuffer &&
    isFilesTextBuffer(activeBuffer) &&
    canSaveFilesBuffer(activeBuffer) &&
    activeBuffer.path &&
    isFilesBufferDirty(activeBuffer),
  );
  if (!canSave || !activeBuffer) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label={intl.formatMessage({ id: "filesWorkbench.save" })}
      title={intl.formatMessage({ id: "filesWorkbench.save" })}
      className="flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      onClick={() => onSave?.(activeBuffer.id)}
    >
      <Save aria-hidden="true" className="size-3.5" />
    </button>
  );
}
