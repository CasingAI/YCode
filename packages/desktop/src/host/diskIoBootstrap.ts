import { HostResponseTypes } from "@zcode/shared";
import { installNodeDiskIoInstrumentation } from "@zcode/shared/node";

// 每个 Window Host 独立采集；窗口关闭时回到轻量 5 秒计数。
const instrumentation = installNodeDiskIoInstrumentation({
  detailedEnabled: false,
  intervalMs: 5_000,
  onBatch: (batch) => {
    try {
      process.parentPort?.postMessage({ type: HostResponseTypes.DiskIoBatch, batch });
    } catch {
      // Host/Main 退出或 IPC 断开时只丢当前增量，不影响业务 I/O。
    }
  },
});

/** Main 窗口会话同步到 Host；不依赖选中的监控 tab。 */
export function setHostDiskIoMonitoringActive(active: boolean, intervalMs: number): void {
  instrumentation.setDetailedEnabled(active);
  instrumentation.setIntervalMs(active ? intervalMs : 5_000);
}
