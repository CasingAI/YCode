import {
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { snapshotFilesTextBuffer } from "@/files-workbench/filesTextDocumentModel.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import type { FilesMonacoTypescriptWorkspaceEntry } from "@/files-workbench/filesMonacoTypescriptWorkspace.js";

/**
 * TS 工作区 entry 的身份 key。
 *
 * 只覆盖 id / 路径 / 工作区 / 加载状态，不包含正文：局部输入不会重建
 * entries，也不会重置 300ms 同步去抖。正文由 `readText` 在同步边界读取。
 */
export function filesWorkbenchTypescriptEntryKey(buffers: readonly FilesBuffer[]): string {
  return buffers
    .flatMap((buffer) =>
      isFilesTextBuffer(buffer) && buffer.path && !buffer.untitled && buffer.loadState === undefined
        ? [
            `${buffer.id}\u0000${buffer.path}\u0000${filesWorkspaceKey(buffer.workspace)}\u0000${buffer.workspace.workspaceRemoteSessionId ?? ""}`,
          ]
        : [],
    )
    .join("\n");
}

export function buildFilesWorkbenchTypescriptEntries(
  buffers: readonly FilesBuffer[],
  store: FilesEditorStore,
): FilesMonacoTypescriptWorkspaceEntry[] {
  return buffers.flatMap((buffer) =>
    isFilesTextBuffer(buffer) && buffer.path && !buffer.untitled && buffer.loadState === undefined
      ? [
          {
            bufferId: buffer.id,
            path: buffer.path,
            text: buffer.text,
            // 同步真正需要正文时再从 Store/模型取快照，逐键路径不读取全文。
            readText: () => {
              const current = findFilesBuffer(store.getState(), buffer.id);
              return current && isFilesTextBuffer(current) ? snapshotFilesTextBuffer(current) : "";
            },
            workspace: buffer.workspace,
          },
        ]
      : [],
  );
}
