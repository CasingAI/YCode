import { parentPort } from "electron";
import { HostResponseTypes } from "@zcode/shared";
import { installNodeDiskIoInstrumentation } from "@zcode/shared/node";

// 每个 Window Host 独立采集并每 5 秒批量汇报；不依赖资源管理器窗口。
installNodeDiskIoInstrumentation({
  intervalMs: 5_000,
  onBatch: (batch) => {
    try {
      parentPort?.postMessage({ type: HostResponseTypes.DiskIoBatch, batch });
    } catch {
      // Host/Main 退出或 IPC 断开时只丢当前增量，不影响业务 I/O。
    }
  },
});
