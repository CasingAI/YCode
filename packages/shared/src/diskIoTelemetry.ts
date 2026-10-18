import { z } from "zod";

/** 固定模块集合：原始路径只用于调用边界内的临时分类，绝不进入统计数据。 */
export const DISK_IO_MODULES = [
  "logging",
  "sqlite",
  "cache",
  "config",
  "session",
  "attachment",
  "storage",
  "filesystem",
  "other",
] as const;
export type DiskIoModule = (typeof DISK_IO_MODULES)[number];

/** 仅统计本机 YCode 的进程；远端 workspace 不混入本机磁盘指标。 */
export const DISK_IO_PROCESSES = ["main", "host", "agent"] as const;
export type DiskIoProcess = (typeof DISK_IO_PROCESSES)[number];

/** P95 使用固定直方图，避免为每次 I/O 保存逐条延迟样本。最后一桶表示大于 5000ms。 */
export const DISK_IO_LATENCY_BUCKET_UPPER_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 5_000,
] as const;
export const DISK_IO_LATENCY_BUCKET_COUNT = DISK_IO_LATENCY_BUCKET_UPPER_MS.length + 1;

const nonNegativeCounter = z.number().finite().nonnegative();
const histogramSchema = z
  .array(z.number().int().nonnegative())
  .length(DISK_IO_LATENCY_BUCKET_COUNT);

export const diskIoMetricValuesSchema = z
  .object({
    readOperations: z.number().int().nonnegative(),
    writeOperations: z.number().int().nonnegative(),
    databaseOperations: z.number().int().nonnegative(),
    unmeasuredReadOperations: z.number().int().nonnegative(),
    unmeasuredWriteOperations: z.number().int().nonnegative(),
    readBytes: nonNegativeCounter,
    writeBytes: nonNegativeCounter,
    failedOperations: z.number().int().nonnegative(),
    failedReadOperations: z.number().int().nonnegative(),
    failedWriteOperations: z.number().int().nonnegative(),
    failedDatabaseOperations: z.number().int().nonnegative(),
    totalDurationMs: nonNegativeCounter,
    latencyHistogram: histogramSchema,
  })
  .strict();
export type DiskIoMetricValues = z.infer<typeof diskIoMetricValuesSchema>;

export const diskIoMetricBatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    sequence: z.number().int().positive(),
    capturedAt: nonNegativeCounter,
    groups: z
      .array(
        z
          .object({
            module: z.enum(DISK_IO_MODULES),
            metrics: diskIoMetricValuesSchema,
          })
          .strict(),
      )
      .max(DISK_IO_MODULES.length),
    osIo: z
      .object({
        available: z.boolean(),
        readBytesDelta: nonNegativeCounter.nullable(),
        writeBytesDelta: nonNegativeCounter.nullable(),
      })
      .strict(),
  })
  .strict();
export type DiskIoMetricBatch = z.infer<typeof diskIoMetricBatchSchema>;

export const diskIoMetricRowSchema = diskIoMetricValuesSchema.extend({
  process: z.enum(DISK_IO_PROCESSES),
  module: z.enum(DISK_IO_MODULES),
});
export type DiskIoMetricRow = z.infer<typeof diskIoMetricRowSchema>;

export interface DiskIoHistorySample {
  /** Main 侧采样桶的 Unix 毫秒时间戳。 */
  timestamp: number;
  /** 本桶的增量，而非累计值；没有活动的来源不会产生行。 */
  rows: DiskIoMetricRow[];
  osIoDelta: Array<{
    process: DiskIoProcess;
    readBytes: number;
    writeBytes: number;
  }>;
}

export interface DiskIoProcessOsTotals {
  readBytes: number;
  writeBytes: number;
}

export interface DiskIoSnapshot {
  startedAt: number;
  capturedAt: number;
  historyIntervalMs: number;
  historyRetentionMs: number;
  /** 应用层逻辑读写量与操作系统进程级 I/O 分开呈现。 */
  osIoAvailable: boolean;
  cumulative: DiskIoMetricRow[];
  history: DiskIoHistorySample[];
  osIoCumulative: Partial<Record<DiskIoProcess, DiskIoProcessOsTotals>>;
  /** 当前日志实现为同步写入，没有独立队列；失败写入按丢弃数统计。 */
  logQueuePending: 0;
  logQueueDropped: number;
}

export function createEmptyDiskIoMetricValues(): DiskIoMetricValues {
  return {
    readOperations: 0,
    writeOperations: 0,
    databaseOperations: 0,
    unmeasuredReadOperations: 0,
    unmeasuredWriteOperations: 0,
    readBytes: 0,
    writeBytes: 0,
    failedOperations: 0,
    failedReadOperations: 0,
    failedWriteOperations: 0,
    failedDatabaseOperations: 0,
    totalDurationMs: 0,
    latencyHistogram: Array.from({ length: DISK_IO_LATENCY_BUCKET_COUNT }, () => 0),
  };
}

export function hasDiskIoMetricValues(metrics: DiskIoMetricValues): boolean {
  return (
    metrics.readOperations > 0 ||
    metrics.writeOperations > 0 ||
    metrics.databaseOperations > 0 ||
    metrics.unmeasuredReadOperations > 0 ||
    metrics.unmeasuredWriteOperations > 0 ||
    metrics.readBytes > 0 ||
    metrics.writeBytes > 0 ||
    metrics.failedOperations > 0 ||
    metrics.totalDurationMs > 0
  );
}
