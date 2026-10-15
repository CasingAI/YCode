import type { SqliteReadRow } from "@zcode/contracts";

export type SqliteReadLaneJob =
  | { kind: "query"; dbPath: string; sql: string; params?: readonly unknown[] }
  | { kind: "tables"; dbPath: string };

export type SqliteReadLaneJobResult =
  | { kind: "query"; rows: SqliteReadRow[] }
  | { kind: "tables"; tables: string[] };

export interface SqliteReadLaneWorkerData {
  timeoutMs: number;
  maxRows: number;
  maxResultBytes: number;
  job: SqliteReadLaneJob;
}

export interface SqliteReadLaneWorkerErrorInfo {
  message: string;
  name?: string;
  code?: string;
  errcode?: number;
}

export type SqliteReadLaneWorkerMessage =
  | { type: "done"; result: SqliteReadLaneJobResult }
  | { type: "error"; error: SqliteReadLaneWorkerErrorInfo };

export function isSqliteReadLaneWorkerMessage(
  value: unknown,
): value is SqliteReadLaneWorkerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { type?: unknown; result?: unknown; error?: unknown };
  if (record.type === "done") return record.result !== undefined;
  if (record.type === "error") {
    if (!record.error || typeof record.error !== "object") return false;
    return typeof (record.error as { message?: unknown }).message === "string";
  }
  return false;
}
