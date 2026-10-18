import { isMainThread, parentPort } from "node:worker_threads";
import { installNodeDiskIoInstrumentation, type NodeDiskIoInstrumentation } from "@zcode/shared/node";
import type { DiskIoMetricBatch } from "@zcode/shared";

const isRemoteRuntime = process.env.ZCODE_TELEMETRY_RUNTIME_SURFACE === "remote_workspace_host";

/**
 * Imported before a short-lived SQLite worker's application modules. The worker shares its PID's
 * OS I/O counters with the parent, so only logical operation metrics are sent back.
 */
const workerPort = !isMainThread ? parentPort : null;
const instrumentation: NodeDiskIoInstrumentation | undefined =
  workerPort && !isRemoteRuntime
    ? installNodeDiskIoInstrumentation({
        intervalMs: 5_000,
        collectOsIo: false,
        onBatch: (batch: DiskIoMetricBatch) => {
          if (batch.groups.length === 0) return;
          try {
            workerPort.postMessage({ type: "telemetry", batch });
          } catch {
            // Worker teardown may race the last report; this is best-effort memory telemetry only.
          }
        },
      })
    : undefined;

/** Flushes the last in-memory delta before the worker reports its result and exits. */
export function stopDiskIoWorkerTelemetry(): void {
  instrumentation?.stop();
}
