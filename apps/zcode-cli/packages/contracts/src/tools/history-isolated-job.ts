// ============================================================
// History 隔离作业 — SessionStorePort 旁路扫描的作业形状
// ============================================================
// SQLite 文件库把 List/Read/Search 整次作业交到只读旁路；假 store / 内存库
// 不实现 runIsolatedHistoryJob，handler 走同一套 history-query 装配。
// 详见 docs/specs/session-history-tools.md。

import type { SessionId } from "../interfaces/shared.js";
import type {
  HistoryListInput,
  HistoryListOutput,
  HistoryReadInput,
  HistoryReadOutput,
  HistorySearchInput,
  HistorySearchOutput,
} from "./history.js";

export type IsolatedHistoryJob =
  | { kind: "list"; input: HistoryListInput }
  | { kind: "read"; input: HistoryReadInput; currentSessionId: SessionId }
  | { kind: "search"; input: HistorySearchInput };

export type IsolatedHistoryJobResult =
  | { kind: "list"; output: HistoryListOutput }
  | { kind: "read"; output: HistoryReadOutput }
  | { kind: "search"; output: HistorySearchOutput };

export interface IsolatedHistoryJobOptions {
  signal?: AbortSignal;
}
