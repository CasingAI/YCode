// ============================================================
// SqliteRead Port - 沙盒只读 SQLite 查询边界
// ============================================================
// 沙盒 `require("node:sqlite")` 的宿主执行面。端口里只有读方法
// （query / listTables），类型层面不提供任何写入口。
// 只读由 adapter 强制：每次调用打开一次性 { readOnly: true } 连接，
// 查询内打开与关闭，不做长活句柄；连接上再挂 setAuthorizer 拒绝
// 写入与 DDL（含 ATTACH）。查询跑在 worker 线程里，超时/取消靠 terminate。
// 规则见 docs/specs/sandbox-system-tool.md「宿主 SQLite」一节。

/** 沙盒 SQLite 查询的一行：列名 → 值。 */
export type SqliteReadRow = Record<string, unknown>;

export type SqliteReadErrorCode =
  | "not_found"
  | "permission_denied"
  | "not_a_database"
  | "read_only"
  | "too_large"
  | "too_many_rows"
  | "invalid_param"
  | "cancelled"
  | "timed_out"
  | "io_error";

export interface SqliteReadErrorDetails {
  code: SqliteReadErrorCode;
  message: string;
  cause?: unknown;
}

export class SqliteReadPortError extends Error {
  readonly code: SqliteReadErrorCode;
  override readonly cause?: unknown;

  constructor(details: SqliteReadErrorDetails) {
    super(details.message);
    this.name = "SqliteReadPortError";
    this.code = details.code;
    this.cause = details.cause;
  }
}

export function createSqliteReadError(details: SqliteReadErrorDetails): SqliteReadPortError {
  return new SqliteReadPortError(details);
}

export function isSqliteReadPortError(error: unknown): error is SqliteReadPortError {
  return error instanceof SqliteReadPortError;
}

export interface SqliteReadQueryInput {
  /** 工作区狱解析后的绝对路径（adapter 不再做狱检查，由 core 在调用前解析）。 */
  dbPath: string;
  sql: string;
  params?: readonly unknown[];
  signal?: AbortSignal;
}

export interface SqliteReadQueryResult {
  rows: SqliteReadRow[];
}

export interface SqliteListTablesInput {
  dbPath: string;
  signal?: AbortSignal;
}

export interface SqliteListTablesResult {
  tables: string[];
}

/** 只读 SQLite 查询端口：只有读方法，无写入口。 */
export interface SqliteReadPort {
  query(input: SqliteReadQueryInput): Promise<SqliteReadQueryResult>;
  listTables(input: SqliteListTablesInput): Promise<SqliteListTablesResult>;
}
