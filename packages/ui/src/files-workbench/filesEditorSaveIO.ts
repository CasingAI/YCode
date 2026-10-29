import {
  type CommitTextFileParams,
  type CommitTextFileResult,
  type FileTextWindow,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  canSaveFilesBuffer,
  detectFilesSaveConflict,
  filesLargeTextEditPatches,
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesLargeTextBuffer,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { filesMonacoPathsEqual } from "@/files-workbench/filesMonacoTypescriptPath.js";
import {
  isFilesTextReadMissingError,
  readFilesTextForOpen,
} from "@/files-workbench/filesEditorTextReader.js";
import { runFilesEditorFileOperation } from "@/files-workbench/filesEditorFileIO.js";
import {
  isCommitConflictError,
  isCommitFailureForUser,
  probeTargetVersion,
  resolveConflictInfo,
} from "@/files-workbench/filesEditorSaveProbe.js";
import {
  applyLargeTextSavedResult,
  refreshLargeTextWindowAfterSave,
} from "@/files-workbench/filesEditorLargeTextSaveApply.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type {
  FilesBuffer,
  FilesLargeTextBuffer,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export interface FilesEditorSaveFileService {
  readTextFileWindow: (args: {
    path: string;
    offset?: number;
    length?: number;
    expectedVersion?: string;
  }) => Promise<FileTextWindow>;
  /** 旧 Host 可能没有该能力；UI 必须明确失败，不能回退 writeTextFile。 */
  commitTextFile: (params: CommitTextFileParams) => Promise<CommitTextFileResult>;
}

/** 冲突回调的完整上下文：覆盖只能绑定弹窗看到的那一版磁盘版本。 */
export interface FilesSaveConflictInfo {
  buffer: FilesBuffer;
  /** 实际保存目标；另存为冲突的 Overwrite 必须继续写这个路径。 */
  path: string;
  /** 探测到的磁盘版本；null 表示文件已删除，undefined 表示无法探测。 */
  observedVersion?: string | null;
  /** 另存为目标的探测版本；null 表示目标不存在。 */
  targetVersion?: string | null;
  /**
   * 冲突只涉及另存为目标的已有版本（源文件基准未变）。
   * 大文件可以显式确认目标版本覆盖，不需要丢弃源草稿。
   */
  targetOnly?: boolean;
  deleted: boolean;
}

/** Controller / Save As 共享的保存请求参数。 */
export interface FilesSaveBufferRequestOptions {
  force?: boolean;
  path?: string;
  observedVersion?: string | null;
  targetVersion?: string | null;
  /** 用户对「文件已被删除」显式选择重建；只有该标记允许 expectedVersion=null。 */
  recreate?: boolean;
}

type FilesSaveConflictHandler = (info: FilesSaveConflictInfo) => void;

export interface SaveFilesBufferOptions {
  store: FilesEditorStore;
  buffer: FilesBuffer;
  /** 保存目标；另存为时允许与 buffer.path 不同。 */
  path: string;
  /** 同一路径覆盖确认；另存为时不跳过目标版本校验。 */
  force?: boolean;
  /** 覆盖确认绑定的磁盘版本；设置后不再为建立基准读取整份文件。 */
  observedVersion?: string | null;
  /** 另存为目标版本；undefined 表示先探测目标，null 表示必须不存在。 */
  targetVersion?: string | null;
  /** 已删除文件经用户明确确认后重建；仅此路径允许 expectedVersion=null。 */
  recreate?: boolean;
  fileService: FilesEditorSaveFileService;
  onConflict: FilesSaveConflictHandler;
  onSaveFailed: (path: string) => void;
  onBusy: () => void;
  onSaved: (params: { path: string; previousPath: string | undefined }) => void;
}

function workspaceIdentityKey(workspace: FilesWorkspaceRef): string {
  return `${filesWorkspaceKey(workspace)}\u0000${workspace.workspaceRemoteSessionId?.trim() ?? ""}`;
}

async function resolveLegacyBaseline(options: {
  fileService: FilesEditorSaveFileService;
  path: string;
  currentText: string;
  savedText: string;
}): Promise<
  | { status: "ok"; version: string }
  | { status: "conflict"; observedVersion: string }
  | { status: "deleted" }
  | { status: "failed"; error: unknown }
> {
  try {
    const read = await readFilesTextForOpen(options.fileService, options.path);
    if (read.mode !== "editable") {
      return { status: "conflict", observedVersion: read.version };
    }
    if (
      detectFilesSaveConflict({
        currentText: options.currentText,
        savedText: options.savedText,
        diskText: read.text,
      }) === "conflict"
    ) {
      return { status: "conflict", observedVersion: read.version };
    }
    return { status: "ok", version: read.version };
  } catch (error) {
    if (isFilesTextReadMissingError(error)) return { status: "deleted" };
    return { status: "failed", error };
  }
}

function isSavableBuffer(buffer: FilesBuffer): boolean {
  // 大文件只要已建立版本基准就可保存：同路径 clean 为 no-op，另存为按空补丁流式复制。
  return isFilesLargeTextBuffer(buffer) ? buffer.edit !== undefined : canSaveFilesBuffer(buffer);
}

function sameSavableBuffer(
  candidate: FilesBuffer | undefined,
  buffer: FilesBuffer,
  identity: string,
): candidate is FilesBuffer {
  return (
    candidate !== undefined &&
    candidate.id === buffer.id &&
    candidate.kind === buffer.kind &&
    isSavableBuffer(candidate) &&
    candidate.path === buffer.path &&
    workspaceIdentityKey(candidate.workspace) === identity
  );
}

function sameCommittedBuffer(
  candidate: FilesBuffer | undefined,
  buffer: FilesBuffer,
  identity: string,
): candidate is FilesBuffer {
  return (
    candidate !== undefined &&
    candidate.id === buffer.id &&
    candidate.kind === buffer.kind &&
    candidate.path === buffer.path &&
    workspaceIdentityKey(candidate.workspace) === identity
  );
}

function failed(options: SaveFilesBufferOptions, error: unknown): false {
  logger.error("[files-workbench] 保存文件失败", { path: options.path, error });
  options.onSaveFailed(options.path);
  return false;
}

async function saveTextBufferToDisk(
  options: SaveFilesBufferOptions,
  current: FilesTextBuffer,
): Promise<boolean> {
  const { fileService, path } = options;
  const sourcePath = current.path;
  const identity = workspaceIdentityKey(current.workspace);
  const samePath = sourcePath !== undefined && filesMonacoPathsEqual(sourcePath, path);
  const isSaveAsTarget = sourcePath === undefined || !samePath;
  // 所有探测 await 结束后都要求运行时基准未变，避免用旧 diskVersion 提交新状态。
  const baselineDiskVersion = current.diskVersion;

  let expectedTargetVersion: string | null | undefined;
  if (isSaveAsTarget) {
    if (options.targetVersion !== undefined) {
      expectedTargetVersion = options.targetVersion;
    } else {
      const target = await probeTargetVersion(fileService, path);
      if (!target.ok) return failed(options, target.error);
      expectedTargetVersion = target.version;
    }
    // 已有目标必须在用户确认（native / modal 后传 force）后才允许按版本覆盖。
    if (expectedTargetVersion !== null && options.force !== true) {
      options.onConflict({
        buffer: current,
        path,
        ...(sourcePath === undefined ? undefined : { observedVersion: current.diskVersion }),
        targetVersion: expectedTargetVersion,
        targetOnly: true,
        deleted: false,
      });
      return false;
    }
  }

  let expectedVersion: string | null;
  if (sourcePath === undefined) {
    // 未命名 / 显式 SaveAs 新目标：目标探测已给出 null 或需要确认的已有版本。
    expectedVersion = expectedTargetVersion ?? null;
  } else if (
    options.force === true &&
    options.observedVersion === undefined &&
    current.diskVersion === undefined
  ) {
    // 未知版本没有形成覆盖授权；即使可以读到当前版本，也不能替用户确认它。
    options.onConflict({ buffer: current, path, observedVersion: undefined, deleted: false });
    return false;
  } else if (options.observedVersion !== undefined) {
    if (options.observedVersion === null) {
      if (options.recreate !== true) {
        options.onConflict({ buffer: current, path, observedVersion: null, deleted: true });
        return false;
      }
      // 删除后的重建是唯一允许 expectedVersion=null 的显式用户动作。
      expectedVersion = null;
    } else {
      expectedVersion = options.observedVersion;
    }
  } else if (current.diskVersion !== undefined) {
    expectedVersion = current.diskVersion;
  } else {
    // 旧版草稿没有运行时 diskVersion：先完整读盘验证其 savedText 基线。
    // 用户确认时若读盘失败 / 版本未知，显式重新提示，不得退化为按读到的最新版本覆盖。
    const baseline = await resolveLegacyBaseline({
      fileService,
      path: sourcePath,
      currentText: current.text,
      savedText: current.savedText,
    });
    if (baseline.status === "failed") {
      if (options.force === true) {
        // 冲突弹窗绑定的版本无法确认：保留草稿并重新呈现未知版本，
        // 绝不能把当前可能更新的磁盘版本解释成用户已经确认覆盖。
        options.onConflict({ buffer: current, path, observedVersion: undefined, deleted: false });
        return false;
      }
      return failed(options, baseline.error);
    }
    if (baseline.status === "deleted") {
      options.onConflict({ buffer: current, path, observedVersion: null, deleted: true });
      return false;
    }
    if (baseline.status === "conflict") {
      options.onConflict({
        buffer: current,
        path,
        observedVersion: baseline.observedVersion,
        deleted: false,
      });
      return false;
    }
    expectedVersion = baseline.version;
  }

  // 读取 / 探测 await 后重新确认同一缓冲仍可保存，且基准没有被其它动作改写。
  const latest = findFilesBuffer(options.store.getState(), current.id);
  if (!sameSavableBuffer(latest, current, identity) || !isFilesTextBuffer(latest)) return false;
  if (latest.diskVersion !== baselineDiskVersion) return false;

  const params: CommitTextFileParams = {
    path,
    expectedVersion,
    ...(sourcePath === undefined || samePath ? undefined : { sourcePath, expectedTargetVersion }),
    write: { kind: "full", text: latest.text },
  };

  let result: CommitTextFileResult;
  try {
    result = await fileService.commitTextFile(params);
  } catch (error) {
    if (isCommitConflictError(error)) {
      options.onConflict(
        await resolveConflictInfo(
          fileService,
          current,
          path,
          sourcePath === undefined
            ? { targetPath: path }
            : { sourcePath, ...(samePath ? undefined : { targetPath: path }) },
        ),
      );
      return false;
    }
    if (isCommitFailureForUser(error)) {
      logger.warn("[files-workbench] 提交文本失败", { path, error });
    }
    return failed(options, error);
  }

  const saved = findFilesBuffer(options.store.getState(), current.id);
  if (!sameCommittedBuffer(saved, current, identity) || !isFilesTextBuffer(saved)) return false;
  // commit await 期间若基准已被别的保存 / 重载改写，不能再把本次结果标记成当前基准。
  if (saved.diskVersion !== baselineDiskVersion) return false;
  options.store.getState().markSaved(current.id, {
    path,
    text: latest.text,
    workspace: current.workspace,
    preserveCurrentText: true,
    version: result.version,
  });
  options.onSaved({ path, previousPath: sourcePath });
  return true;
}

async function saveLargeTextBufferToDisk(
  options: SaveFilesBufferOptions,
  current: FilesLargeTextBuffer,
): Promise<boolean> {
  const { fileService, path } = options;
  const edit = current.edit;
  if (!edit) return false;
  const patches = filesLargeTextEditPatches(current);
  const sourcePath = current.path;
  const identity = workspaceIdentityKey(current.workspace);
  const samePath = filesMonacoPathsEqual(sourcePath, path);

  // clean 大文件同路径保存是 no-op；另存为则必须提交空补丁由 Host 流式复制。
  if (samePath && patches.length === 0) return true;

  let expectedTargetVersion: string | null | undefined;
  if (!samePath) {
    if (options.targetVersion !== undefined) {
      expectedTargetVersion = options.targetVersion;
    } else {
      const target = await probeTargetVersion(fileService, path);
      if (!target.ok) return failed(options, target.error);
      expectedTargetVersion = target.version;
    }
    if (expectedTargetVersion !== null && options.force !== true) {
      options.onConflict({
        buffer: current,
        path,
        observedVersion: edit.baseVersion,
        targetVersion: expectedTargetVersion,
        targetOnly: true,
        deleted: false,
      });
      return false;
    }
  }

  // 目标探测 await 后必须仍以同一基准提交；期间重载 / 重基线则放弃本次补丁集。
  const latest = findFilesBuffer(options.store.getState(), current.id);
  if (!sameSavableBuffer(latest, current, identity) || !isFilesLargeTextBuffer(latest))
    return false;
  if (latest.edit?.baseVersion !== edit.baseVersion) return false;

  const params: CommitTextFileParams = {
    path,
    expectedVersion: edit.baseVersion,
    ...(samePath ? undefined : { sourcePath, expectedTargetVersion }),
    write: { kind: "patches", patches },
  };

  let result: CommitTextFileResult;
  try {
    result = await fileService.commitTextFile(params);
  } catch (error) {
    if (isCommitConflictError(error)) {
      // 大文件不允许把补丁强套到新版本：只能取消或放弃草稿后重载。
      options.onConflict(
        await resolveConflictInfo(fileService, current, path, {
          sourcePath,
          targetPath: path,
        }),
      );
      return false;
    }
    return failed(options, error);
  }

  const saved = findFilesBuffer(options.store.getState(), current.id);
  if (
    !sameCommittedBuffer(saved, current, identity) ||
    !isFilesLargeTextBuffer(saved) ||
    saved.edit?.baseVersion !== edit.baseVersion
  ) {
    return false;
  }
  // 提交期间由 Store 锁住块编辑，新基准必须重新分块，不能平移旧块补丁。
  applyLargeTextSavedResult(options.store, current, result);
  // 展示重载与写盘结果解耦：这里只触发新版本读取，失败不回滚已提交的保存。
  refreshLargeTextWindowAfterSave(options.store, current.id, result);
  options.onSaved({ path, previousPath: sourcePath });
  return true;
}

/**
 * 保存完整文本或大文件块补丁。
 *
 * 所有写盘统一走 `commitTextFile`：普通文本提交完整正文，大文件提交基于
 * `edit.baseVersion` 的补丁。保存成功后只有缓冲身份未变才标记已保存；
 * 保存 await 期间的新输入不会被清掉。
 */
export async function saveFilesTextBuffer(options: SaveFilesBufferOptions): Promise<boolean> {
  const { store, buffer, fileService } = options;
  if (typeof fileService.commitTextFile !== "function") {
    logger.error("[files-workbench] 当前 Host 不支持 commitTextFile，拒绝保存", {
      path: options.path,
    });
    options.onSaveFailed(options.path);
    return false;
  }
  const identity = workspaceIdentityKey(buffer.workspace);

  return runFilesEditorFileOperation(
    buffer.workspace,
    async () => {
      const current = findFilesBuffer(store.getState(), buffer.id);
      if (!sameSavableBuffer(current, buffer, identity)) return false;
      if (isFilesLargeTextBuffer(current)) {
        const token = store.getState().beginLargeTextSave(current.id);
        if (!token) return false;
        try {
          return await saveLargeTextBufferToDisk(options, current);
        } finally {
          store.getState().endLargeTextSave(current.id, token);
        }
      }
      if (isFilesTextBuffer(current)) return saveTextBufferToDisk(options, current);
      return false;
    },
    options.onBusy,
  );
}
