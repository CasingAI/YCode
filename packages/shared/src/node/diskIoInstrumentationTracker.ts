import { randomUUID } from "node:crypto";
import {
  DISK_IO_LATENCY_BUCKET_COUNT,
  DISK_IO_LATENCY_BUCKET_UPPER_MS,
  createEmptyDiskIoMetricValues,
  type DiskIoMetricBatch,
  type DiskIoMetricValues,
  type DiskIoModule,
} from "../diskIoTelemetry.js";
import { originalReadFileSync, type DiskIoRecorder, type IoKind } from "./diskIoInstrumentationShared.js";

export interface NodeDiskIoInstrumentation {
  flush(): DiskIoMetricBatch;
  setBatchHandler(handler: (batch: DiskIoMetricBatch) => void | Promise<void>): void;
  stop(options?: { flushFinal?: boolean }): void;
}

export interface DiskIoInstrumentationOptions {
  intervalMs?: number;
  /** Worker threads share the parent PID's OS counters; disable this to avoid double counting. */
  collectOsIo?: boolean;
  onBatch: (batch: DiskIoMetricBatch) => void | Promise<void>;
}

export type DiskIoTracker = NodeDiskIoInstrumentation & DiskIoRecorder;

function latencyBucket(durationMs: number): number {
  const index = DISK_IO_LATENCY_BUCKET_UPPER_MS.findIndex((upperBound) => durationMs <= upperBound);
  return index === -1 ? DISK_IO_LATENCY_BUCKET_COUNT - 1 : index;
}

export function createDiskIoTracker(options: DiskIoInstrumentationOptions): DiskIoTracker {
  const onBatch = options.onBatch;
  const intervalMs = options.intervalMs ?? 5_000;
  const collectOsIo = options.collectOsIo ?? true;
  const instanceId = randomUUID().replace(/-/g, "");
  const pending = new Map<DiskIoModule, DiskIoMetricValues>();
  let sequence = 0;
  let timer: NodeJS.Timeout | undefined;
  let batchHandler = onBatch;
  let previousOsIo = collectOsIo ? readLinuxProcessIo() : null;

  function ensure(module: DiskIoModule): DiskIoMetricValues {
    let metrics = pending.get(module);
    if (!metrics) {
      metrics = createEmptyDiskIoMetricValues();
      pending.set(module, metrics);
    }
    return metrics;
  }

  function record(
    module: DiskIoModule,
    kind: IoKind,
    durationMs: number,
    bytes: number | null,
    failed: boolean,
  ): void {
    const metrics = ensure(module);
    if (kind === "read") {
      metrics.readOperations += 1;
      if (bytes === null) metrics.unmeasuredReadOperations += 1;
      else metrics.readBytes += bytes;
    } else if (kind === "write") {
      metrics.writeOperations += 1;
      if (bytes === null) metrics.unmeasuredWriteOperations += 1;
      else metrics.writeBytes += bytes;
    } else {
      metrics.databaseOperations += 1;
    }
    if (failed) {
      metrics.failedOperations += 1;
      if (kind === "read") metrics.failedReadOperations += 1;
      else if (kind === "write") metrics.failedWriteOperations += 1;
      else metrics.failedDatabaseOperations += 1;
    }
    const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    metrics.totalDurationMs += safeDuration;
    const bucket = latencyBucket(safeDuration);
    metrics.latencyHistogram[bucket] = (metrics.latencyHistogram[bucket] ?? 0) + 1;
  }

  function flush(): DiskIoMetricBatch {
    const osIoNow = collectOsIo ? readLinuxProcessIo() : null;
    let readBytesDelta: number | null = null;
    let writeBytesDelta: number | null = null;
    if (process.platform === "linux" && osIoNow) {
      if (previousOsIo) {
        readBytesDelta = Math.max(0, osIoNow.readBytes - previousOsIo.readBytes);
        writeBytesDelta = Math.max(0, osIoNow.writeBytes - previousOsIo.writeBytes);
      }
      previousOsIo = osIoNow;
    }
    const groups = [...pending.entries()].map(([module, metrics]) => ({
      module,
      metrics: { ...metrics, latencyHistogram: [...metrics.latencyHistogram] },
    }));
    pending.clear();
    sequence += 1;
    return {
      schemaVersion: 1,
      instanceId,
      sequence,
      capturedAt: Date.now(),
      groups,
      osIo: {
        available: collectOsIo && process.platform === "linux",
        readBytesDelta,
        writeBytesDelta,
      },
    };
  }

  function flushAndReport(): void {
    try {
      void Promise.resolve(batchHandler(flush())).catch(() => {
        // IPC/协议异步汇报失败只能丢失当前内存增量，不得影响业务 I/O。
      });
    } catch {
      // 同步指标汇报失败也只能丢失当前内存增量，不得影响业务 I/O。
    }
  }

  timer = setInterval(flushAndReport, intervalMs);
  timer.unref?.();
  process.once("beforeExit", flushAndReport);

  return {
    record,
    flush,
    setBatchHandler(handler: (batch: DiskIoMetricBatch) => void | Promise<void>) {
      batchHandler = handler;
    },
    stop(options?: { flushFinal?: boolean }) {
      if (timer) clearInterval(timer);
      timer = undefined;
      process.removeListener("beforeExit", flushAndReport);
      if (options?.flushFinal !== false) flushAndReport();
    },
  };
}

function readLinuxProcessIo(): { readBytes: number; writeBytes: number } | null {
  if (process.platform !== "linux") return null;
  try {
    // 只读 procfs；使用安装包装前保存的原始函数，避免把监控自身的读数算入业务 I/O。
    const contents = originalReadFileSync("/proc/self/io", "utf8");
    if (typeof contents !== "string") return null;
    const read = /^read_bytes:\s*(\d+)$/m.exec(contents)?.[1];
    const written = /^write_bytes:\s*(\d+)$/m.exec(contents)?.[1];
    if (read === undefined || written === undefined) return null;
    return { readBytes: Number(read), writeBytes: Number(written) };
  } catch {
    return null;
  }
}
