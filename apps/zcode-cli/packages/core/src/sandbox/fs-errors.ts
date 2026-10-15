// 沙盒 FS 拒绝与 Node 形 errno。三类产品拒绝不得混用档位文案。

import { isFileSystemPortError, type FileSystemErrorCode } from "@zcode/contracts";

export const SANDBOX_FS_READONLY = "SANDBOX_FS_READONLY";
export const SANDBOX_FS_SYNC = "SANDBOX_FS_SYNC";
export const SANDBOX_FS_CALLBACK = "SANDBOX_FS_CALLBACK";
export const SANDBOX_FS_UNSUPPORTED = "SANDBOX_FS_UNSUPPORTED";
export const SANDBOX_FS_NO_HOST = "SANDBOX_FS_NO_HOST";
export const SANDBOX_FS_TOO_LARGE = "SANDBOX_FS_TOO_LARGE";

export class SandboxFsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Error";
    this.code = code;
  }
}

export function sandboxReadonlyError(method: string): SandboxFsError {
  return new SandboxFsError(
    SANDBOX_FS_READONLY,
    `${method} is not allowed in the current work mode (Ask/Plan cannot write the workspace). Switch to Agent or use a read method.`,
  );
}

export function sandboxSyncError(method: string): SandboxFsError {
  return new SandboxFsError(
    SANDBOX_FS_SYNC,
    `Sandbox has no synchronous fs (${method}). Use fs.promises instead.`,
  );
}

export function sandboxCallbackError(method: string): SandboxFsError {
  return new SandboxFsError(
    SANDBOX_FS_CALLBACK,
    `Sandbox has no callback fs (${method}). Use fs.promises.${method}.`,
  );
}

export function sandboxUnsupportedError(method: string): SandboxFsError {
  return new SandboxFsError(
    SANDBOX_FS_UNSUPPORTED,
    `Sandbox has not implemented ${method}. Load the sandbox skill (references/fs.md).`,
  );
}

const PORT_CODE_TO_NODE: Record<FileSystemErrorCode, string> = {
  not_found: "ENOENT",
  permission_denied: "EACCES",
  is_directory: "EISDIR",
  not_directory: "ENOTDIR",
  directory_not_empty: "ENOTEMPTY",
  not_file: "ENOTDIR",
  too_large: SANDBOX_FS_TOO_LARGE,
  stale_write: "EPERM",
  invalid_path: "EINVAL",
  invalid_pattern: "EINVAL",
  unsupported: SANDBOX_FS_UNSUPPORTED,
  cancelled: "ECANCELED",
  io_error: "EIO",
};

export function fromPortOrUnknown(error: unknown): SandboxFsError {
  if (error instanceof SandboxFsError) return error;
  if (isFileSystemPortError(error)) {
    return new SandboxFsError(PORT_CODE_TO_NODE[error.code] ?? "EIO", error.message);
  }
  if (error instanceof Error) return new SandboxFsError("EIO", error.message);
  return new SandboxFsError("EIO", String(error));
}
