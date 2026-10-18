import {
  DISK_IO_LATENCY_BUCKET_UPPER_MS,
  createEmptyDiskIoMetricValues,
  type DiskIoMetricRow,
  type DiskIoMetricValues,
  type DiskIoModule,
  type DiskIoProcess,
  type DiskIoSnapshot,
} from "@zcode/shared";

export type DiskIoProcessFilter = DiskIoProcess | "all";
export type DiskIoModuleFilter = DiskIoModule | "all";

export interface DiskIoSummary extends DiskIoMetricValues {
  operationCount: number;
  averageDurationMs: number | null;
  p95UpperBoundMs: number | null;
  p95OverUpperBound: boolean;
}

export function summarizeDiskIoRows(rows: readonly DiskIoMetricRow[]): DiskIoSummary {
  const metrics = createEmptyDiskIoMetricValues();
  for (const row of rows) {
    metrics.readOperations += row.readOperations;
    metrics.writeOperations += row.writeOperations;
    metrics.databaseOperations += row.databaseOperations;
    metrics.unmeasuredReadOperations += row.unmeasuredReadOperations;
    metrics.unmeasuredWriteOperations += row.unmeasuredWriteOperations;
    metrics.readBytes += row.readBytes;
    metrics.writeBytes += row.writeBytes;
    metrics.failedOperations += row.failedOperations;
    metrics.failedReadOperations += row.failedReadOperations;
    metrics.failedWriteOperations += row.failedWriteOperations;
    metrics.failedDatabaseOperations += row.failedDatabaseOperations;
    metrics.totalDurationMs += row.totalDurationMs;
    for (let index = 0; index < metrics.latencyHistogram.length; index += 1) {
      metrics.latencyHistogram[index] =
        (metrics.latencyHistogram[index] ?? 0) + (row.latencyHistogram[index] ?? 0);
    }
  }
  const operationCount =
    metrics.readOperations + metrics.writeOperations + metrics.databaseOperations;
  const percentile = getDiskIoP95(metrics.latencyHistogram);
  return {
    ...metrics,
    operationCount,
    averageDurationMs: operationCount > 0 ? metrics.totalDurationMs / operationCount : null,
    p95UpperBoundMs: percentile.upperBoundMs,
    p95OverUpperBound: percentile.overUpperBound,
  };
}

export function getDiskIoP95(histogram: readonly number[]): {
  upperBoundMs: number | null;
  overUpperBound: boolean;
} {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return { upperBoundMs: null, overUpperBound: false };
  const target = Math.ceil(total * 0.95);
  let accumulated = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    accumulated += histogram[index] ?? 0;
    if (accumulated >= target) {
      if (index >= DISK_IO_LATENCY_BUCKET_UPPER_MS.length) {
        return { upperBoundMs: null, overUpperBound: true };
      }
      return {
        upperBoundMs: DISK_IO_LATENCY_BUCKET_UPPER_MS[index] ?? null,
        overUpperBound: false,
      };
    }
  }
  return { upperBoundMs: null, overUpperBound: true };
}

export function filterDiskIoRows(
  rows: readonly DiskIoMetricRow[],
  processFilter: DiskIoProcessFilter,
  moduleFilter: DiskIoModuleFilter,
): DiskIoMetricRow[] {
  return rows.filter(
    (row) =>
      (processFilter === "all" || row.process === processFilter) &&
      (moduleFilter === "all" || row.module === moduleFilter),
  );
}

export function getDiskIoRateFromLatestBucket(
  snapshot: DiskIoSnapshot,
  kind: "read" | "write",
): number {
  const latest = snapshot.history[snapshot.history.length - 1];
  if (!latest || snapshot.historyIntervalMs <= 0) return 0;
  const bytes = latest.rows.reduce(
    (total, row) => total + (kind === "read" ? row.readBytes : row.writeBytes),
    0,
  );
  return (bytes * 1_000) / snapshot.historyIntervalMs;
}

export function formatDiskIoDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";
  if (durationMs < 1) return `${(durationMs * 1_000).toFixed(0)} µs`;
  if (durationMs < 100) return `${durationMs.toFixed(1)} ms`;
  return `${durationMs.toFixed(0)} ms`;
}

export function formatDiskIoP95(summary: DiskIoSummary): string {
  if (summary.operationCount === 0) return "—";
  if (summary.p95OverUpperBound) return "> 5,000 ms";
  return summary.p95UpperBoundMs === null ? "—" : `≤ ${summary.p95UpperBoundMs} ms`;
}
