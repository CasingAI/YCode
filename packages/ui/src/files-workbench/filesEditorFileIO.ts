import { filesEditorMutationMatchesPath } from "@/files-workbench/filesEditorFileMutations.js";
import { useWorkspaceFileActionStore } from "@/store/workspaceFileActionStore.js";
import { getWorkspaceFileActionKey } from "@/workspace-file-tree/fileActionRules.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesPendingOpen, FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

/** 旧路径读取完成后，必须在同一次同步提交前验证变更事实与请求所有权。 */
export async function readCurrentFilesEditorPath<T>(options: {
  store: FilesEditorStore;
  workspace: FilesWorkspaceRef;
  path: string;
  request?: FilesPendingOpen;
  read: () => Promise<T>;
  accept?: (result: T) => void;
  reject?: (error: unknown) => void;
}): Promise<T | null> {
  let valid = true;
  const isCurrent = () =>
    valid && (!options.request || options.store.getState().pendingOpenInFlight === options.request);
  const unsubscribe = options.store.subscribe((state, previous) => {
    const mutation = state.lastFileMutation;
    if (!mutation || mutation === previous.lastFileMutation) return;
    if (
      filesEditorMutationMatchesPath(mutation, options.workspace, options.path) ||
      (mutation.newPath &&
        filesEditorMutationMatchesPath(
          { ...mutation, path: mutation.newPath },
          options.workspace,
          options.path,
        ))
    ) {
      valid = false;
    }
  });
  try {
    const result = await options.read();
    // 改名会替换并重新准入打开请求；旧读取不得用旧 path 创建缓冲，也不能清掉新请求。
    if (!isCurrent()) return null;
    options.accept?.(result);
    return result;
  } catch (error) {
    // 同一文件改名后再改回可复用旧 ID；旧失败也不能把新读取的 loading 状态改成 error。
    if (!isCurrent()) return null;
    if (!options.reject) throw error;
    options.reject(error);
    return null;
  } finally {
    unsubscribe();
  }
}

/** 保存和文件树变更共用窗口内现有准入 owner，防止旧 write 在删除后重新创建原路径。 */
export async function runFilesEditorFileOperation(
  workspace: FilesWorkspaceRef,
  operation: () => Promise<boolean>,
  onBusy?: () => void,
): Promise<boolean> {
  const key = getWorkspaceFileActionKey({
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    remoteSessionId: workspace.workspaceRemoteSessionId,
  });
  const actions = useWorkspaceFileActionStore.getState();
  if (!actions.beginOperation(key)) {
    onBusy?.();
    return false;
  }
  try {
    return await operation();
  } finally {
    actions.endOperation(key);
  }
}
