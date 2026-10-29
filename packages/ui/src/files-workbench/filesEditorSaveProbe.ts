import {
  FILE_TEXT_COMMIT_CONFLICT_CODE,
  FILE_TEXT_INVALID_PATCH_CODE,
  FILE_TEXT_NOT_FILE_CODE,
} from "@zcode/shared";
import { isFilesTextReadMissingError } from "@/files-workbench/filesEditorTextReader.js";
import type {
  FilesSaveConflictInfo,
  FilesEditorSaveFileService,
} from "@/files-workbench/filesEditorSaveIO.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

/** 保存探测 / 错误分类帮助函数，保持主保存流程在 max-lines 预算内。 */

export function isCommitConflictError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === FILE_TEXT_COMMIT_CONFLICT_CODE
  );
}

export function isCommitFailureForUser(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const code = (error as { code?: unknown }).code;
  return code === FILE_TEXT_INVALID_PATCH_CODE || code === FILE_TEXT_NOT_FILE_CODE;
}

export async function probeObservedVersion(
  fileService: FilesEditorSaveFileService,
  path: string,
): Promise<FilesSaveConflictInfo["observedVersion"]> {
  try {
    const window = await fileService.readTextFileWindow({ path, offset: 0, length: 4 });
    return window.version;
  } catch (error) {
    return isFilesTextReadMissingError(error) ? null : undefined;
  }
}

export async function resolveConflictInfo(
  fileService: FilesEditorSaveFileService,
  buffer: FilesBuffer,
  path: string,
  options?: { sourcePath?: string; targetPath?: string },
): Promise<FilesSaveConflictInfo> {
  const observedVersion =
    options?.sourcePath === undefined
      ? undefined
      : await probeObservedVersion(fileService, options.sourcePath);
  let targetVersion: string | null | undefined;
  if (options?.targetPath !== undefined) {
    targetVersion = await probeObservedVersion(fileService, options.targetPath);
  }
  return {
    buffer,
    path,
    observedVersion,
    ...(options?.targetPath === undefined ? undefined : { targetVersion }),
    deleted: options?.sourcePath !== undefined && observedVersion === null,
  };
}

export async function probeTargetVersion(
  fileService: FilesEditorSaveFileService,
  path: string,
): Promise<{ ok: true; version: string | null } | { ok: false; error: unknown }> {
  try {
    const window = await fileService.readTextFileWindow({ path, offset: 0, length: 4 });
    return { ok: true, version: window.version };
  } catch (error) {
    if (isFilesTextReadMissingError(error)) return { ok: true, version: null };
    return { ok: false, error };
  }
}
