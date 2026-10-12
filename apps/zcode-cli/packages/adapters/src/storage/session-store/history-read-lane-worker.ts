/**
 * History 只读旁路工作线程：打开一次性 { readOnly: true } 连接，跑完 List/Read/Search
 * 装配后关闭连接并退出。不跑迁移，不碰主连接。
 * 见 docs/specs/session-history-tools.md。
 */
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { runIsolatedHistoryQuery } from "@zcode/contracts/history-query";
import { createHistoryReadStore } from "./history-read-lane-store.js";
import type {
  HistoryReadLaneWorkerData,
  HistoryReadLaneWorkerMessage,
} from "./history-read-lane-protocol.js";

const port = parentPort;
if (!isMainThread && port) {
  const data = workerData as HistoryReadLaneWorkerData;
  const post = (message: HistoryReadLaneWorkerMessage) => port.postMessage(message);
  void runHistoryReadLaneJob(data)
    .then((result) => post({ type: "done", result }))
    .catch((error: unknown) => {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
      });
    });
}

async function runHistoryReadLaneJob(data: HistoryReadLaneWorkerData) {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(data.dbPath, { readOnly: true, timeout: data.timeoutMs });
    const store = createHistoryReadStore(db);
    return await runIsolatedHistoryQuery(store, data.job);
  } finally {
    db?.close();
  }
}
