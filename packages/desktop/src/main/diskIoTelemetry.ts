import { DiskIoTelemetryStore, DISK_IO_HISTORY_INTERVAL_MS } from "./diskIoTelemetryStore.js";
import { installNodeDiskIoInstrumentation } from "@zcode/shared/node";
import type { DiskIoMetricBatch, DiskIoProcess, DiskIoSnapshot } from "@zcode/shared";

const store = new DiskIoTelemetryStore({
  osIoAvailable: process.platform === "linux",
  historyIntervalMs: DISK_IO_HISTORY_INTERVAL_MS,
});
let started = false;
let instrumentation: ReturnType<typeof installNodeDiskIoInstrumentation> | undefined;

/** Main 常驻只汇总全局计数；详细历史只在资源管理器窗口会话中存在。 */
export function startDiskIoTelemetry(): void {
  if (started) return;
  started = true;
  instrumentation = installNodeDiskIoInstrumentation({
    detailedEnabled: false,
    intervalMs: DISK_IO_HISTORY_INTERVAL_MS,
    onBatch: (batch) => {
      store.ingestBatch("main", batch);
      store.flushHistory(batch.capturedAt);
    },
  });
}

/** 接收 Host/Agent 的批量增量；重复或过期序号由 store 丢弃。 */
export function ingestDiskIoBatch(
  process: Exclude<DiskIoProcess, "main">,
  batch: DiskIoMetricBatch,
): boolean {
  return store.ingestBatch(process, batch);
}

export function getDiskIoTelemetrySnapshot(): DiskIoSnapshot {
  return store.getSnapshot();
}

/** 仅由资源管理器窗口生命周期调用，标签切换不得停止此会话。 */
export function startDiskIoMonitoringSession(): void {
  instrumentation?.setDetailedEnabled(true);
  store.startSession();
}

export function stopDiskIoMonitoringSession(): void {
  store.stopSession();
  instrumentation?.setDetailedEnabled(false);
}
