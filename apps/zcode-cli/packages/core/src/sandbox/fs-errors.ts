// 沙盒 FS 拒绝与 Node 形 errno。三类产品拒绝不得混用档位文案。

import { isFileSystemPortError, type FileSystemErrorCode } from "@zcode/contracts";

export const SANDBOX_FS_READONLY = "SANDBOX_FS_READONLY";
/**
 * 历史同步禁用码：已支持的 *Sync 方法不再抛出它。
 * 保留常量只为识别旧调用记录，不作为新契约。
 */
export const SANDBOX_FS_SYNC = "SANDBOX_FS_SYNC";
export const SANDBOX_FS_SYNC_DISABLED = SANDBOX_FS_SYNC;
export const SANDBOX_FS_CALLBACK = "SANDBOX_FS_CALLBACK";
export const SANDBOX_FS_UNSUPPORTED = "SANDBOX_FS_UNSUPPORTED";
export const SANDBOX_FS_NO_HOST = "SANDBOX_FS_NO_HOST";
export const SANDBOX_FS_TOO_LARGE = "SANDBOX_FS_TOO_LARGE";
/** 同步桥自身失败（超时、容量、序列化）。 */
export const SANDBOX_FS_SYNC_BRIDGE = "SANDBOX_FS_SYNC_BRIDGE";
/** 主线程收到已过期 generation / 已销毁实例的同步请求。 */
export const SANDBOX_FS_STALE_GENERATION = "SANDBOX_FS_STALE_GENERATION";

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
    `JSVM_FS_SYNC_DISABLED: Synchronous filesystem APIs are not supported (${method}). Use an asynchronous filesystem API instead.`,
  );
}

/** 同步桥失败 / 陈旧 generation 的统一错误（主线程写入 SAB 时使用）。 */
export function sandboxSyncBridgeError(message: string): SandboxFsError {
  return new SandboxFsError(SANDBOX_FS_SYNC_BRIDGE, message);
}

export function sandboxStaleGenerationError(method: string): SandboxFsError {
  return new SandboxFsError(
    SANDBOX_FS_STALE_GENERATION,
    `${method} was rejected because the sandbox instance that issued it is no longer current. Retry in the new instance.`,
  );
}

export function sandboxCallbackError(method: string): SandboxFsError {
  return new SandboxFsError(
    SANDBOX_FS_CALLBACK,
    `Sandbox does not support callback-only filesystem API ${method}; no FileSystemPort operation is available.`,
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
