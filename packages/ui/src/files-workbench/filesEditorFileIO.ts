import { filesEditorMutationMatchesPath } from "@/files-workbench/filesEditorFileMutations.js";
import {
  createLargeTextFileBuffer,
  createPreviewBuffer,
  createTextFileBuffer,
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesLargeTextBuffer,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { seedFilesLargeTextWindowFromBuffer } from "@/files-workbench/filesLargeTextWindowSeed.js";
import type { FilesTextReadResult } from "@/files-workbench/filesEditorTextReader.js";
import { useWorkspaceFileActionStore } from "@/store/workspaceFileActionStore.js";
import { getWorkspaceFileActionKey } from "@/workspace-file-tree/fileActionRules.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type {
  FilesOpenMode,
  FilesPendingOpen,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

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

/**
 * 提交一次统一读取决策结果；打开与恢复共用同一个提交口。
 *
 * `targetId` 仅接受仍为 loading、同一工作区身份且未被编辑的文本缓冲。
 * 磁盘已超过可编辑阈值时在原 ID 内转为只读大文本，不把首窗正文写进缓冲。
 */
export function commitFilesEditorTextReadResult(options: {
  store: FilesEditorStore;
  workspace: FilesWorkspaceRef;
  path: string;
  result: FilesTextReadResult;
  mode?: FilesOpenMode;
  targetId?: string;
}): FilesTextReadResult["mode"] | null {
  const state = options.store.getState();
  if (options.targetId) {
    const current = findFilesBuffer(state, options.targetId);
    if (
      !current ||
      !isFilesTextBuffer(current) ||
      current.path !== options.path ||
      filesWorkspaceKey(current.workspace) !== filesWorkspaceKey(options.workspace) ||
      current.loadState !== "loading"
    ) {
      return null;
    }
    // 读取在途时的编辑是用户草稿：迟到结果不得覆盖正文、改基准或转只读视图。
    // 清掉 loading，避免标签一直停在加载态。
    if (current.untitled || isFilesBufferDirty(current)) {
      state.setTextLoadState(current.id, undefined);
      return null;
    }
    if (options.result.mode === "binary") {
      state.convertTextBufferToPreview(options.targetId);
      return "binary";
    }
    if (options.result.mode === "large-text") {
      state.convertTextBufferToLargeText(options.targetId, {
        totalBytes: options.result.totalBytes,
        readonlyReason: options.result.reason,
      });
      const large = findFilesBuffer(options.store.getState(), options.targetId);
      if (large && isFilesLargeTextBuffer(large)) {
        // 编辑基准必须先于首窗建立：viewer 挂载后不会再把干净草稿重基线。
        state.initializeLargeTextEdit(large.id, options.result.version, options.result.totalBytes);
        // 首窗已由 core 决策读到；prime 给唯一 owner，viewer 挂载后不再重复读。
        seedFilesLargeTextWindowFromBuffer(large, options.result.firstWindow);
      }
      return "large-text";
    }
    state.restoreTextContent(options.targetId, {
      text: options.result.text,
      version: options.result.version,
    });
    return "editable";
  }

  if (options.result.mode === "binary") {
    state.openBuffer(
      createPreviewBuffer({ workspace: options.workspace, path: options.path }),
      options.mode,
    );
    return "binary";
  }
  if (options.result.mode === "large-text") {
    const buffer = createLargeTextFileBuffer({
      workspace: options.workspace,
      path: options.path,
      totalBytes: options.result.totalBytes,
      readonlyReason: options.result.reason,
    });
    state.openBuffer(buffer, options.mode);
    state.initializeLargeTextEdit(buffer.id, options.result.version, options.result.totalBytes);
    seedFilesLargeTextWindowFromBuffer(buffer, options.result.firstWindow);
    return "large-text";
  }
  const opened = createTextFileBuffer({
    workspace: options.workspace,
    path: options.path,
    text: options.result.text,
  });
  state.openBuffer(opened, options.mode);
  // 打开即记录磁盘版本；之后保存直接用 commitTextFile，不再每次完整预读。
  state.markSaved(opened.id, {
    path: options.path,
    text: options.result.text,
    workspace: options.workspace,
    version: options.result.version,
  });
  return "editable";
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
