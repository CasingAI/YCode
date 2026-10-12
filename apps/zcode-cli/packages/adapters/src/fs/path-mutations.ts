// 沙盒 FS 所需的路径级变更：lstat / realpath / 二进制写 / 追加 / 改名 / 单文件拷 /
// 删空目录 / 递归删。与 NodeFileSystemAdapter 共用绝对路径与错误码映射，不直出给
// 沙盒（沙盒只调 FileSystemPort）。

import { lstat, mkdir, realpath, rename, rm, rmdir, copyFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import {
  createFileSystemError,
  isFileSystemPortError,
  type FileSystemAppendFileRequest,
  type FileSystemCopyFileRequest,
  type FileSystemCopyFileResult,
  type FileSystemNodeKind,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemRemoveTreeRequest,
  type FileSystemRenameRequest,
  type FileSystemRenameResult,
  type FileSystemStatRequest,
  type FileSystemStatResult,
  type FileSystemWriteBinaryRequest,
  type FileSystemWriteTextResult,
} from "@zcode/contracts";

function resolveAbsoluteRequestPath(path: string): string {
  if (!isAbsolute(path)) {
    throw createFileSystemError({
      code: "invalid_path",
      path,
      message: `FileSystemPort requires an absolute path: ${path}`,
    });
  }
  return normalize(path);
}

function getNodeErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function nodeKind(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

function toPathMutationError(error: unknown, path: string): Error {
  if (isFileSystemPortError(error)) return error;
  const code = getNodeErrorCode(error);
  if (code === "ENOENT") {
    return createFileSystemError({ code: "not_found", path, message: `File not found: ${path}`, cause: error });
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message: `Permission denied for path: ${path}`,
      cause: error,
    });
  }
  if (code === "EISDIR") {
    return createFileSystemError({ code: "is_directory", path, message: `Path is a directory: ${path}`, cause: error });
  }
  if (code === "ENOTDIR") {
    return createFileSystemError({
      code: "not_directory",
      path,
      message: `Path is not a directory: ${path}`,
      cause: error,
    });
  }
  if (code === "ENOTEMPTY") {
    return createFileSystemError({
      code: "directory_not_empty",
      path,
      message: `Directory is not empty: ${path}`,
      cause: error,
    });
  }
  return createFileSystemError({
    code: "io_error",
    path,
    message: error instanceof Error ? error.message : `File system error for path: ${path}`,
    cause: error,
  });
}

function revisionFromStat(info: { mtimeMs: number; size: number }): FileSystemWriteTextResult["revision"] {
  return {
    id: `mtime:${Math.trunc(info.mtimeMs)}:size:${info.size}`,
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
  };
}

export async function lstatPath(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  try {
    const info = await lstat(path);
    const kind = nodeKind(info);
    return {
      path,
      kind,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      revision:
        kind === "file"
          ? { id: `mtime:${Math.trunc(info.mtimeMs)}:size:${info.size}`, mtimeMs: info.mtimeMs, sizeBytes: info.size }
          : undefined,
    };
  } catch (error) {
    throw toPathMutationError(error, path);
  }
}

export async function realpathPath(request: FileSystemStatRequest): Promise<{ path: string }> {
  const path = resolveAbsoluteRequestPath(request.path);
  try {
    return { path: await realpath(path) };
  } catch (error) {
    throw toPathMutationError(error, path);
  }
}

export async function writeBinaryPath(request: FileSystemWriteBinaryRequest): Promise<FileSystemWriteTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  try {
    if (request.createParents === true) {
      await mkdir(dirname(path), { recursive: true });
    }
    await writeFile(path, request.content);
    const info = await lstat(path);
    return { path, bytesWritten: request.content.byteLength, revision: revisionFromStat(info) };
  } catch (error) {
    throw toPathMutationError(error, path);
  }
}

export async function appendFilePath(request: FileSystemAppendFileRequest): Promise<FileSystemWriteTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  try {
    const payload =
      typeof request.content === "string" ? Buffer.from(request.content, "utf8") : Buffer.from(request.content);
    await appendFile(path, payload);
    const info = await lstat(path);
    const bytesWritten = payload.byteLength;
    return { path, bytesWritten, revision: revisionFromStat(info) };
  } catch (error) {
    throw toPathMutationError(error, path);
  }
}

export async function renamePath(request: FileSystemRenameRequest): Promise<FileSystemRenameResult> {
  const fromPath = resolveAbsoluteRequestPath(request.fromPath);
  const toPath = resolveAbsoluteRequestPath(request.toPath);
  try {
    await rename(fromPath, toPath);
    return { fromPath, toPath };
  } catch (error) {
    throw toPathMutationError(error, fromPath);
  }
}

export async function copyFilePath(request: FileSystemCopyFileRequest): Promise<FileSystemCopyFileResult> {
  const fromPath = resolveAbsoluteRequestPath(request.fromPath);
  const toPath = resolveAbsoluteRequestPath(request.toPath);
  try {
    await copyFile(fromPath, toPath);
    return { fromPath, toPath };
  } catch (error) {
    throw toPathMutationError(error, fromPath);
  }
}

export async function removeDirectoryPath(
  request: FileSystemRemoveFileRequest,
): Promise<FileSystemRemoveFileResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  try {
    await rmdir(path);
    return { path, removed: true };
  } catch (error) {
    const normalized = toPathMutationError(error, path);
    if (request.missingOk === true && isFileSystemPortError(normalized) && normalized.code === "not_found") {
      return { path, removed: false };
    }
    throw normalized;
  }
}

export async function removeTreePath(request: FileSystemRemoveTreeRequest): Promise<FileSystemRemoveFileResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  try {
    await rm(path, { recursive: request.recursive === true, force: request.force === true });
    return { path, removed: true };
  } catch (error) {
    const normalized = toPathMutationError(error, path);
    if (
      (request.missingOk === true || request.force === true) &&
      isFileSystemPortError(normalized) &&
      normalized.code === "not_found"
    ) {
      return { path, removed: false };
    }
    throw normalized;
  }
}
