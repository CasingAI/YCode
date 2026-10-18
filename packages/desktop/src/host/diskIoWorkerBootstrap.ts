import { isMainThread, parentPort } from "node:worker_threads";
import { installNodeDiskIoInstrumentation, type NodeDiskIoInstrumentation } from "@zcode/shared/node";
import type { DiskIoMetricBatch } from "@zcode/shared";

/** Worker threads share their parent process's OS counters; only logical metrics are relayed. */
const workerPort = !isMainThread ? parentPort : null;
const instrumentation: NodeDiskIoInstrumentation | undefined =
  workerPort
    ? installNodeDiskIoInstrumentation({
        intervalMs: 5_000,
        collectOsIo: false,
        onBatch: (batch: DiskIoMetricBatch) => {
          if (batch.groups.length === 0) return;
          try {
            workerPort.postMessage({ type: "disk-io-batch", batch });
          } catch {
            // Best-effort in-memory metrics must never affect storage preparation.
          }
        },
      })
    : undefined;

export function stopDiskIoWorkerTelemetry(): void {
  instrumentation?.stop();
}
