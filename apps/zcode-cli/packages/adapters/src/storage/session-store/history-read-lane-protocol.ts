import type { IsolatedHistoryJob, IsolatedHistoryJobResult } from "@zcode/contracts";

export interface HistoryReadLaneWorkerData {
  dbPath: string;
  timeoutMs: number;
  job: IsolatedHistoryJob;
}

export type HistoryReadLaneWorkerMessage =
  | { type: "done"; result: IsolatedHistoryJobResult }
  | { type: "error"; message: string; name?: string };

export function isHistoryReadLaneWorkerMessage(
  value: unknown,
): value is HistoryReadLaneWorkerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { type?: unknown; result?: unknown; message?: unknown; name?: unknown };
  if (record.type === "done") return record.result !== undefined;
  if (record.type === "error") return typeof record.message === "string";
  return false;
}
