// 沙盒 SQLite 查询拒绝：与 FS 三类产品拒绝同形，码各自分开。

import { isSqliteReadPortError, type SqliteReadErrorCode } from "@zcode/contracts";
import { SandboxFsError } from "./fs-errors.js";

export const SANDBOX_SQLITE_NO_HOST = "SANDBOX_SQLITE_NO_HOST";
export const SANDBOX_SQLITE_READ_ONLY = "SANDBOX_SQLITE_READ_ONLY";
export const SANDBOX_SQLITE_NOT_FOUND = "SANDBOX_SQLITE_NOT_FOUND";
export const SANDBOX_SQLITE_NOT_A_DATABASE = "SANDBOX_SQLITE_NOT_A_DATABASE";
export const SANDBOX_SQLITE_TOO_MANY_ROWS = "SANDBOX_SQLITE_TOO_MANY_ROWS";
export const SANDBOX_SQLITE_TOO_LARGE = "SANDBOX_SQLITE_TOO_LARGE";
export const SANDBOX_SQLITE_INVALID_PARAM = "SANDBOX_SQLITE_INVALID_PARAM";
export const SANDBOX_SQLITE_TIMEOUT = "SANDBOX_SQLITE_TIMEOUT";
export const SANDBOX_SQLITE_CANCELLED = "SANDBOX_SQLITE_CANCELLED";

export class SandboxSqliteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Error";
    this.code = code;
  }
}

export function sandboxSqliteNoHostError(): SandboxSqliteError {
  return new SandboxSqliteError(SANDBOX_SQLITE_NO_HOST, "Sandbox sqlite host is not configured");
}

const PORT_CODE_TO_SANDBOX: Record<SqliteReadErrorCode, string> = {
  not_found: SANDBOX_SQLITE_NOT_FOUND,
  permission_denied: SANDBOX_SQLITE_READ_ONLY,
  not_a_database: SANDBOX_SQLITE_NOT_A_DATABASE,
  read_only: SANDBOX_SQLITE_READ_ONLY,
  too_large: SANDBOX_SQLITE_TOO_LARGE,
  too_many_rows: SANDBOX_SQLITE_TOO_MANY_ROWS,
  invalid_param: SANDBOX_SQLITE_INVALID_PARAM,
  cancelled: SANDBOX_SQLITE_CANCELLED,
  timed_out: SANDBOX_SQLITE_TIMEOUT,
  io_error: "EIO",
};

export function fromSqlitePortOrUnknown(error: unknown): SandboxSqliteError {
  if (error instanceof SandboxSqliteError) return error;
  // 狱错误是同步 throw 的 SandboxFsError：透传，不吞成 EIO。
  if (error instanceof SandboxFsError) {
    return new SandboxSqliteError(error.code, error.message);
  }
  if (isSqliteReadPortError(error)) {
    return new SandboxSqliteError(PORT_CODE_TO_SANDBOX[error.code] ?? "EIO", error.message);
  }
  if (error instanceof Error) return new SandboxSqliteError("EIO", error.message);
  return new SandboxSqliteError("EIO", String(error));
}
