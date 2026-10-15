// 沙盒只读 SQLite 查询端口的默认实现：经 SqliteReadLane 跑 worker 线程。
// 错误映射：worker 交回的 errcode / code 落到 SqliteReadPortError 码上。

export { createSqliteReadLane, SqliteReadLane } from "./read-lane.js";
export type { SqliteReadLaneOptions } from "./read-lane.js";
export { sqliteReadLaneWorkerUrl } from "./read-lane-worker-url.js";

import {
  createSqliteReadError,
  type SqliteListTablesInput,
  type SqliteListTablesResult,
  type SqliteReadErrorCode,
  type SqliteReadPort,
  type SqliteReadQueryInput,
  type SqliteReadQueryResult,
} from "@zcode/contracts";
import { createSqliteReadLane, type SqliteReadLaneOptions } from "./read-lane.js";

export interface SqliteReadPortOptions extends SqliteReadLaneOptions {}

function mapLaneError(error: unknown): never {
  const record = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  const code = typeof record?.code === "string" ? record.code : undefined;
  const errcode = typeof record?.errcode === "number" ? record.errcode : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  throw createSqliteReadError({ code: toPortCode(code, errcode), message, cause: error });
}

function toPortCode(code: string | undefined, errcode: number | undefined): SqliteReadErrorCode {
  // Node 实测：只读库被写 → errcode 8；打不开文件 → errcode 14；
  // authorizer 拒绝（含 ATTACH）→ errcode 23；非数据库文件 → errcode 26。
  if (code === "timed_out") return "timed_out";
  if (code === "too_many_rows") return "too_many_rows";
  if (code === "too_large") return "too_large";
  // 非法参数独立成码：模型该改的是参数形状，不是缩小结果集。
  if (code === "invalid_param") return "invalid_param";
  if (errcode === 23 || errcode === 8) return "read_only";
  if (errcode === 14) return "not_found";
  if (errcode === 26) return "not_a_database";
  if (code === "ERR_SQLITE_ERROR") return "io_error";
  if (errorNameIsAbort(code)) return "cancelled";
  return "io_error";
}

function errorNameIsAbort(code: string | undefined): boolean {
  return code === "AbortError";
}

export function createSqliteReadPort(options?: SqliteReadPortOptions): SqliteReadPort {
  const lane = createSqliteReadLane(options);
  return {
    async query(input: SqliteReadQueryInput): Promise<SqliteReadQueryResult> {
      try {
        const result = await lane.enqueue(
          { kind: "query", dbPath: input.dbPath, sql: input.sql, params: input.params },
          input.signal,
        );
        if (result.kind !== "query")
          throw new Error("Sqlite read lane returned a mismatched result");
        return { rows: result.rows };
      } catch (error) {
        mapLaneError(error);
      }
    },
    async listTables(input: SqliteListTablesInput): Promise<SqliteListTablesResult> {
      try {
        const result = await lane.enqueue({ kind: "tables", dbPath: input.dbPath }, input.signal);
        if (result.kind !== "tables")
          throw new Error("Sqlite read lane returned a mismatched result");
        return { tables: result.tables };
      } catch (error) {
        mapLaneError(error);
      }
    },
  };
}
