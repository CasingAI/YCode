import type { IFileService } from "@zcode/services";
import { filesEditorMutationMatchesPath } from "../files-workbench/filesEditorFileMutations.js";
import { writeFilesEditorSession } from "../files-workbench/filesEditorPersistence.js";
import type { FilesEditorStore } from "../files-workbench/filesEditorStore.js";
import type { FilesWorkspaceRef } from "../files-workbench/filesEditorTypes.js";
import { disposeFilesMonacoModel } from "../files-workbench/filesMonacoModels.js";
import { useWorkspaceFileActionStore } from "../store/workspaceFileActionStore.js";
import { getWorkspaceFileActionKey } from "./fileActionRules.js";

export type WorkspaceFileMutation = Parameters<IFileService["mutateWorkspaceEntry"]>[0]["mutation"];
export type WorkspaceFileMutationResult = Awaited<ReturnType<IFileService["mutateWorkspaceEntry"]>>;

interface WorkspaceFileMutationRunParams {
  workspace: FilesWorkspaceRef;
  fileService: Pick<IFileService, "mutateWorkspaceEntry">;
  editorStore: FilesEditorStore;
  mutation: WorkspaceFileMutation;
  clipboardId?: string;
}

export async function runWorkspaceFileMutation({
  workspace,
  fileService,
  editorStore,
  mutation,
  clipboardId,
}: WorkspaceFileMutationRunParams): Promise<WorkspaceFileMutationResult> {
  const workspaceKey = getWorkspaceFileActionKey({
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    remoteSessionId: workspace.workspaceRemoteSessionId,
  });
  const actions = useWorkspaceFileActionStore.getState();
  if (!actions.beginOperation(workspaceKey)) {
    throw new Error("workspace-file-operation-busy");
  }

  try {
    const result = await fileService.mutateWorkspaceEntry({
      rootPath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      mutation,
    });
    if (
      result.changed &&
      (mutation.kind === "rename" || mutation.kind === "move" || mutation.kind === "delete")
    ) {
      const previousBufferIds = editorStore.getState().buffers.map((buffer) => buffer.id);
      editorStore.getState().applyFileMutation({
        workspace,
        kind: mutation.kind,
        path: result.previousPath ?? mutation.path,
        newPath: result.path,
      });
      const currentBufferIds = new Set(editorStore.getState().buffers.map((buffer) => buffer.id));
      // Store 已保留迁移后的脏正文；旧 id 的 Monaco 模型不能继续占用已失效的文件 URI。
      for (const id of previousBufferIds) {
        if (!currentBufferIds.has(id)) disposeFilesMonacoModel(id);
      }
      writeFilesEditorSession(editorStore.getState().snapshotSession());
    }

    const clipboard = useWorkspaceFileActionStore.getState().clipboard;
    if (
      mutation.kind === "move" &&
      clipboardId !== undefined &&
      clipboard?.id === clipboardId &&
      clipboard.operation === "cut"
    ) {
      // 同目录移动虽不改磁盘，仍已完成本次剪切；按 id 消费以保留等待期间的新复制项。
      actions.clearClipboard(clipboardId);
    } else if (
      result.changed &&
      (mutation.kind === "rename" || mutation.kind === "delete") &&
      clipboard &&
      getWorkspaceFileActionKey(clipboard) === workspaceKey &&
      filesEditorMutationMatchesPath(
        { workspace, kind: mutation.kind, path: result.previousPath ?? mutation.path },
        workspace,
        clipboard.path,
      )
    ) {
      actions.clearClipboard(clipboard.id);
    }
    return result;
  } finally {
    actions.endOperation(workspaceKey);
  }
}
