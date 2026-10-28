import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import type { FilesTextBuffer } from "@/files-workbench/filesEditorTypes.js";
import {
  isFilesWorkspaceLocalTarget,
  type FilesWorkspaceServiceTab,
} from "@/files-workbench/filesWorkspaceFileService.js";
import { FilesSaveAsDialog } from "@/files-workbench/FilesSaveAsDialog.js";
import type { useFilesWorkbenchController } from "@/files-workbench/useFilesWorkbenchController.js";

/**
 * 另存为弹窗的工作台接线：目标、取消 / 确认后的保存链保持原有语义，
 * 原生选路准入只在这里根据 Desktop 与本机目标决定。
 */
export function FilesWorkbenchSaveAsDialog({
  controller,
  isDesktop,
  workspaceTabs,
  pendingSaveDirectory,
  saveAsBuffer,
}: {
  controller: ReturnType<typeof useFilesWorkbenchController>;
  isDesktop: boolean;
  workspaceTabs: readonly FilesWorkspaceServiceTab[];
  pendingSaveDirectory?: string;
  saveAsBuffer?: FilesTextBuffer;
}) {
  const allowNativePath = Boolean(
    isDesktop &&
    saveAsBuffer &&
    isFilesWorkspaceLocalTarget({ workspace: saveAsBuffer.workspace, workspaceTabs }),
  );

  return (
    <FilesSaveAsDialog
      open={Boolean(saveAsBuffer)}
      bufferId={saveAsBuffer?.id}
      workspaceKey={saveAsBuffer ? filesWorkspaceKey(saveAsBuffer.workspace) : undefined}
      defaultDirectory={pendingSaveDirectory ?? saveAsBuffer?.workspace.workspacePath}
      defaultFileName={saveAsBuffer?.title}
      fileService={
        saveAsBuffer ? controller.resolveServices(saveAsBuffer.workspace).fileService : undefined
      }
      allowNativePath={allowNativePath}
      onCancel={() => {
        controller.setSaveAsBufferId(undefined);
        controller.cancelPendingClose();
        // 另存为被取消：全部保存就此停止，剩余文件保持未保存。
        controller.stopSaveAll();
      }}
      onConfirm={(path) => {
        if (!saveAsBuffer) return;
        controller.setSaveAsBufferId(undefined);
        void controller.saveTextBuffer(saveAsBuffer, { path, force: true }).then((saved) => {
          if (saved) {
            controller.resumePendingClose();
            void controller.resumeSaveAll();
          } else {
            controller.stopSaveAll();
          }
        });
      }}
    />
  );
}
