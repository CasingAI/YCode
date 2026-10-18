import { DiskIoTelemetryStore, DISK_IO_HISTORY_INTERVAL_MS } from "./diskIoTelemetryStore.js";
import { installNodeDiskIoInstrumentation } from "@zcode/shared/node";
import type { DiskIoMetricBatch, DiskIoProcess, DiskIoSnapshot } from "@zcode/shared";

const store = new DiskIoTelemetryStore({
  osIoAvailable: process.platform === "linux",
  historyIntervalMs: DISK_IO_HISTORY_INTERVAL_MS,
});
let started = false;

/** 仅 Main 持有总计数器和历史窗口；该服务不依赖 Resources Manager 窗口。 */
export function startDiskIoTelemetry(): void {
  if (started) return;
  started = true;
  installNodeDiskIoInstrumentation({
    intervalMs: DISK_IO_HISTORY_INTERVAL_MS,
    onBatch: (batch) => {
      store.ingestBatch("main", batch);
      store.flushHistory(batch.capturedAt);
    },
  });
}

/** 接收 Host/Agent 的批量增量；重复或过期序号由 store 丢弃。 */
export function ingestDiskIoBatch(process: Exclude<DiskIoProcess, "main">, batch: DiskIoMetricBatch): boolean {
  return store.ingestBatch(process, batch);
}

export function getDiskIoTelemetrySnapshot(): DiskIoSnapshot {
  return store.getSnapshot();
}
