import { logger } from "@/logger.js";
import {
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesLargeTextBuffer,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import {
  isFilesTextReadMissingError,
  readFilesTextForOpen,
} from "@/files-workbench/filesEditorTextReader.js";
import { disposeFilesMonacoModel } from "@/files-workbench/filesMonacoModels.js";
import {
  filesLargeTextWindowOwner,
  seedFilesLargeTextWindowFromBuffer,
} from "@/files-workbench/filesLargeTextWindowSeed.js";
import { disposeFilesLargeTextWindow } from "@/files-workbench/filesLargeTextWindowStore.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type {
  FilesDiskProbeFileService,
} from "@/files-workbench/filesEditorDiskSync.js";
import type {
  FilesBuffer,
  FilesExternalChange,
} from "@/files-workbench/filesEditorTypes.js";

function workspaceIdentityKey(workspace: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): string {
  return `${filesWorkspaceKey(workspace)}\u0000${workspace.workspaceRemoteSessionId?.trim() ?? ""}`;
}

/**
 * 用磁盘内容替换缓冲（冲突 / 外部变化 / 显式放弃草稿）。
 *
 * `allowDirty=false` 时读取完成后如果出现新输入就放弃提交；所有分支共用
 * `readFilesTextForOpen` 的完整读取决策，不在这里另判阈值。
 */
export async function reloadFilesBufferFromDisk(options: {
  store: FilesEditorStore;
  bufferId: string;
  allowDirty?: boolean;
  fileService: FilesDiskProbeFileService;
  isCurrentRequest: () => boolean;
  persist: () => void;
}): Promise<boolean> {
  const { store, bufferId } = options;
  const buffer = findFilesBuffer(store.getState(), bufferId);
  if (!buffer || !buffer.path) return false;
  const path = buffer.path;
  const identity = workspaceIdentityKey(buffer.workspace);
  // 读取 await 期间可能产生新输入：记录读取开始时的身份与草稿快照，
  // 只有快照完全未变才允许用磁盘内容替换，避免静默丢掉新草稿。
  const startKind = buffer.kind;
  const startText = isFilesTextBuffer(buffer) ? buffer.text : undefined;
  const startSavedText = isFilesTextBuffer(buffer) ? buffer.savedText : undefined;
  const startDiskVersion = isFilesTextBuffer(buffer) ? buffer.diskVersion : undefined;
  const startEdit = isFilesLargeTextBuffer(buffer) ? buffer.edit : undefined;
  const snapshotUnchanged = (candidate: FilesBuffer): boolean => {
    if (candidate.kind !== startKind) return false;
    if (isFilesTextBuffer(candidate)) {
      return (
        candidate.text === startText &&
        candidate.savedText === startSavedText &&
        candidate.diskVersion === startDiskVersion
      );
    }
    if (isFilesLargeTextBuffer(candidate)) {
      return (
        candidate.edit?.revision === startEdit?.revision &&
        candidate.edit?.baseVersion === startEdit?.baseVersion &&
        candidate.edit?.baseTotalBytes === startEdit?.baseTotalBytes
      );
    }
    return true;
  };

  let result;
  try {
    result = await readFilesTextForOpen(options.fileService, path);
  } catch (error) {
    if (!options.isCurrentRequest()) return false;
    // 只有明确 ENOENT 才提示删除；离线 / 权限失败不能把文件当成已删除。
    if (isFilesTextReadMissingError(error)) {
      const current = findFilesBuffer(store.getState(), bufferId);
      // 缓冲已被替换 / 正在保存时不能把旧请求的删除结论写到新状态上。
      if (
        current &&
        current.kind === startKind &&
        current.kind !== "preview" &&
        current.path === path &&
        workspaceIdentityKey(current.workspace) === identity &&
        !(isFilesLargeTextBuffer(current) && current.saveToken)
      ) {
        const change: FilesExternalChange = { kind: "deleted", observedVersion: null };
        if (isFilesLargeTextBuffer(current)) {
          store.getState().setLargeTextExternalChange(bufferId, change);
        } else if (isFilesTextBuffer(current)) {
          store.getState().setTextExternalChange(bufferId, change);
        }
      }
    }
    logger.warn("[files-workbench] 重载文件失败", { path, error });
    return false;
  }
  if (!options.isCurrentRequest()) return false;
  const current = findFilesBuffer(store.getState(), bufferId);
  if (
    !current ||
    !snapshotUnchanged(current) ||
    current.path !== path ||
    workspaceIdentityKey(current.workspace) !== identity ||
    current.kind === "preview" ||
    (isFilesLargeTextBuffer(current) && current.saveToken)
  ) {
    return false;
  }
  if (!options.allowDirty && isFilesBufferDirty(current)) return false;

  if (result.mode === "binary") {
    store.getState().convertTextBufferToPreview(bufferId, { allowDirty: true });
    disposeFilesMonacoModel(bufferId);
    options.persist();
    return true;
  }

  if (result.mode === "editable") {
    if (isFilesLargeTextBuffer(current)) {
      store.getState().completeLargeTextAsText(bufferId, { text: result.text });
      store.getState().markSaved(bufferId, {
        path,
        text: result.text,
        workspace: current.workspace,
        version: result.version,
      });
      disposeFilesMonacoModel(bufferId);
    } else if (isFilesTextBuffer(current)) {
      store.getState().markSaved(bufferId, {
        path,
        text: result.text,
        workspace: current.workspace,
        preserveCurrentText: false,
        version: result.version,
      });
    } else {
      return false;
    }
    options.persist();
    return true;
  }

  if (!isFilesLargeTextBuffer(current)) {
    if (!isFilesTextBuffer(current)) return false;
    store.getState().convertTextBufferToLargeText(bufferId, {
      totalBytes: result.totalBytes,
      readonlyReason: result.reason,
      allowDirty: true,
    });
    disposeFilesMonacoModel(bufferId);
  }
  store.getState().setLargeTextTotalBytes(bufferId, result.totalBytes, result.reason);
  // 显式重载（allowDirty）在读取成功且快照未变后才能丢弃旧块草稿；
  // 普通自动重载只会在缓冲干净时走到这里。
  if (options.allowDirty) store.getState().discardLargeTextEdits(bufferId);
  store.getState().initializeLargeTextEdit(bufferId, result.version, result.totalBytes);
  const large = findFilesBuffer(store.getState(), bufferId);
  if (large && isFilesLargeTextBuffer(large)) {
    // 同一 owner 上替换窗口：保留 lease / 订阅，viewer 直接拿到新首窗。
    disposeFilesLargeTextWindow(large.id, filesLargeTextWindowOwner(large));
    seedFilesLargeTextWindowFromBuffer(large, result.firstWindow);
  }
  options.persist();
  return true;
}
