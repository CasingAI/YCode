import type { FileTextWindow } from "@zcode/shared";
import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import {
  seedFilesLargeTextWindow,
  type FilesLargeTextWindowOwner,
} from "@/files-workbench/filesLargeTextWindowStore.js";
import { failFilesLargeTextWindow } from "@/files-workbench/filesLargeTextWindowFailure.js";
import type { FilesLargeTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/** rangeStore 的唯一 owner 身份；buffer 本身不保存窗口正文或偏移。 */
export function filesLargeTextWindowOwner(buffer: FilesLargeTextBuffer): FilesLargeTextWindowOwner {
  return {
    bufferId: buffer.id,
    workspaceKey: filesWorkspaceKey(buffer.workspace),
    remoteSessionId: buffer.workspace.workspaceRemoteSessionId?.trim() ?? "",
    path: buffer.path,
  };
}

/** 把 core 决策已经读到的首窗 prime 给 viewer，避免挂载后重复读首窗。 */
export function seedFilesLargeTextWindowFromBuffer(
  buffer: FilesLargeTextBuffer,
  firstWindow: FileTextWindow,
): boolean {
  return seedFilesLargeTextWindow(filesLargeTextWindowOwner(buffer), firstWindow);
}

/**
 * core 首次决策失败时把错误和统一重试入口交给 viewer 的同一 owner entry。
 * 重试由 core loader 重新执行完整决策，不直接按窗口读取。
 */
export function failFilesLargeTextWindowSeed(
  buffer: FilesLargeTextBuffer,
  error: unknown,
  retry: () => void | Promise<void>,
): void {
  failFilesLargeTextWindow(filesLargeTextWindowOwner(buffer), error, retry);
}
