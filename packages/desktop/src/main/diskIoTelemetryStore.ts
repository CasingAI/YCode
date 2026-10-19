import {
  DISK_IO_MODULES,
  DISK_IO_PROCESSES,
  createEmptyDiskIoMetricValues,
  diskIoMetricBatchSchema,
  hasDiskIoMetricValues,
  type DiskIoGlobalTotals,
  type DiskIoHistorySample,
  type DiskIoMetricBatch,
  type DiskIoMetricRow,
  type DiskIoMetricValues,
  type DiskIoProcess,
  type DiskIoProcessOsTotals,
  type DiskIoSnapshot,
} from "@zcode/shared";

export const DISK_IO_HISTORY_INTERVAL_MS = 5_000;
export const DISK_IO_HISTORY_BUCKETS = 360;
export const DISK_IO_DEDUPLICATION_LIMIT = 1_024;

type MetricKey = `${DiskIoProcess}:${(typeof DISK_IO_MODULES)[number]}`;

function metricKey(process: DiskIoProcess, module: DiskIoMetricRow["module"]): MetricKey {
  return `${process}:${module}`;
}

function mergeMetrics(target: DiskIoMetricValues, delta: DiskIoMetricValues): void {
  target.readOperations += delta.readOperations;
  target.writeOperations += delta.writeOperations;
  target.databaseOperations += delta.databaseOperations;
  target.unmeasuredReadOperations += delta.unmeasuredReadOperations;
  target.unmeasuredWriteOperations += delta.unmeasuredWriteOperations;
  target.readBytes += delta.readBytes;
  target.writeBytes += delta.writeBytes;
  target.failedOperations += delta.failedOperations;
  target.failedReadOperations += delta.failedReadOperations;
  target.failedWriteOperations += delta.failedWriteOperations;
  target.failedDatabaseOperations += delta.failedDatabaseOperations;
  target.totalDurationMs += delta.totalDurationMs;
  for (let index = 0; index < target.latencyHistogram.length; index += 1) {
    target.latencyHistogram[index] =
      (target.latencyHistogram[index] ?? 0) + (delta.latencyHistogram[index] ?? 0);
  }
}

function cloneMetrics(metrics: DiskIoMetricValues): DiskIoMetricValues {
  return { ...metrics, latencyHistogram: [...metrics.latencyHistogram] };
}

function createMetricMap(): Map<MetricKey, DiskIoMetricValues> {
  return new Map();
}

function ensureMetric(
  map: Map<MetricKey, DiskIoMetricValues>,
  process: DiskIoProcess,
  module: DiskIoMetricRow["module"],
): DiskIoMetricValues {
  const key = metricKey(process, module);
  let metrics = map.get(key);
  if (!metrics) {
    metrics = createEmptyDiskIoMetricValues();
    map.set(key, metrics);
  }
  return metrics;
}

function mapToRows(map: Map<MetricKey, DiskIoMetricValues>): DiskIoMetricRow[] {
  const rows: DiskIoMetricRow[] = [];
  for (const process of DISK_IO_PROCESSES) {
    for (const module of DISK_IO_MODULES) {
      const metrics = map.get(metricKey(process, module));
      if (metrics && hasDiskIoMetricValues(metrics)) {
        rows.push({ process, module, ...cloneMetrics(metrics) });
      }
    }
  }
  return rows;
}

/**
 * Main 进程持有的唯一统计事实源。只接受固定 schema 的批次，去重、累计并维护有界历史；
 * 不读写文件、不调用数据库、不发送网络请求，也不保存逐次 I/O 事件。
 */
export class DiskIoTelemetryStore {
  private readonly globalTotals: DiskIoGlobalTotals = {
    readBytes: 0,
    writeBytes: 0,
    readOperations: 0,
    writeOperations: 0,
    databaseOperations: 0,
    failedOperations: 0,
  };
  private readonly cumulative = createMetricMap();
  private readonly pending = createMetricMap();
  private readonly osIoCumulative = new Map<DiskIoProcess, DiskIoProcessOsTotals>();
  private readonly osIoPending = new Map<DiskIoProcess, DiskIoProcessOsTotals>();
  private readonly history: DiskIoHistorySample[] = [];
  private readonly lastSequenceByInstance = new Map<string, number>();
  private osIoSampleCount = 0;
  private sessionStartedAt: number | null = null;
  private readonly startedAt: number;

  constructor(
    private readonly options: {
      osIoAvailable: boolean;
      now?: () => number;
      historyIntervalMs?: number;
      historyBuckets?: number;
      deduplicationLimit?: number;
    },
  ) {
    this.startedAt = (options.now ?? Date.now)();
  }

  /** 监控窗口生命周期决定详细统计的起止；同一会话反复调用不会重置。 */
  startSession(): void {
    if (this.sessionStartedAt !== null) return;
    this.clearSession();
    this.sessionStartedAt = (this.options.now ?? Date.now)();
  }

  stopSession(): void {
    this.sessionStartedAt = null;
    this.clearSession();
  }

  private clearSession(): void {
    this.cumulative.clear();
    this.pending.clear();
    this.osIoCumulative.clear();
    this.osIoPending.clear();
    this.history.length = 0;
    this.osIoSampleCount = 0;
  }

  ingestBatch(process: DiskIoProcess, untrustedBatch: DiskIoMetricBatch): boolean {
    const parsed = diskIoMetricBatchSchema.safeParse(untrustedBatch);
    if (!parsed.success) return false;
    const batch = parsed.data;
    const dedupeKey = `${process}:${batch.instanceId}`;
    const lastSequence = this.lastSequenceByInstance.get(dedupeKey);
    if (lastSequence !== undefined && batch.sequence <= lastSequence) return false;

    // 刷新插入顺序并限制实例去重表大小，避免长时间运行时无限增长。
    this.lastSequenceByInstance.delete(dedupeKey);
    this.lastSequenceByInstance.set(dedupeKey, batch.sequence);
    const deduplicationLimit = this.options.deduplicationLimit ?? DISK_IO_DEDUPLICATION_LIMIT;
    while (this.lastSequenceByInstance.size > deduplicationLimit) {
      const oldest = this.lastSequenceByInstance.keys().next().value;
      if (oldest === undefined) break;
      this.lastSequenceByInstance.delete(oldest);
    }

    for (const group of batch.groups) {
      const metrics = group.metrics;
      this.globalTotals.readBytes += metrics.readBytes;
      this.globalTotals.writeBytes += metrics.writeBytes;
      this.globalTotals.readOperations += metrics.readOperations;
      this.globalTotals.writeOperations += metrics.writeOperations;
      this.globalTotals.databaseOperations += metrics.databaseOperations;
      this.globalTotals.failedOperations += metrics.failedOperations;
      // 没有监控窗口时，不创建任何进程/模块明细或时间桶。
      if (this.sessionStartedAt === null || batch.capturedAt < this.sessionStartedAt) continue;
      mergeMetrics(ensureMetric(this.cumulative, process, group.module), metrics);
      mergeMetrics(ensureMetric(this.pending, process, group.module), metrics);
    }

    if (
      this.sessionStartedAt !== null &&
      batch.capturedAt >= this.sessionStartedAt &&
      this.options.osIoAvailable &&
      batch.osIo.available
    ) {
      const { readBytesDelta, writeBytesDelta } = batch.osIo;
      if (readBytesDelta !== null && writeBytesDelta !== null) {
        const cumulative = this.osIoCumulative.get(process) ?? { readBytes: 0, writeBytes: 0 };
        const pending = this.osIoPending.get(process) ?? { readBytes: 0, writeBytes: 0 };
        this.osIoSampleCount += 1;
        cumulative.readBytes += readBytesDelta;
        cumulative.writeBytes += writeBytesDelta;
        pending.readBytes += readBytesDelta;
        pending.writeBytes += writeBytesDelta;
        this.osIoCumulative.set(process, cumulative);
        this.osIoPending.set(process, pending);
      }
    }
    return true;
  }

  /** 由 Main 的固定 5 秒定时器调用；每个桶只保留增量。 */
  flushHistory(timestamp = (this.options.now ?? Date.now)()): void {
    if (this.sessionStartedAt === null) return;
    const rows = mapToRows(this.pending);
    const osIoDelta = [...this.osIoPending.entries()]
      .filter(([, totals]) => totals.readBytes > 0 || totals.writeBytes > 0)
      .map(([process, totals]) => ({ process, ...totals }));
    const sample: DiskIoHistorySample = { timestamp, rows, osIoDelta };
    this.history.push(sample);
    const bucketLimit = this.options.historyBuckets ?? DISK_IO_HISTORY_BUCKETS;
    while (this.history.length > bucketLimit) this.history.shift();
    this.pending.clear();
    this.osIoPending.clear();
  }

  getSnapshot(capturedAt = (this.options.now ?? Date.now)()): DiskIoSnapshot {
    const cumulative = mapToRows(this.cumulative);
    const history = this.history.map((sample) => ({
      timestamp: sample.timestamp,
      rows: sample.rows.map((row) => ({ ...row, latencyHistogram: [...row.latencyHistogram] })),
      osIoDelta: sample.osIoDelta.map((item) => ({ ...item })),
    }));
    const osIoCumulative: Partial<Record<DiskIoProcess, DiskIoProcessOsTotals>> = {};
    for (const process of DISK_IO_PROCESSES) {
      const totals = this.osIoCumulative.get(process);
      if (totals) osIoCumulative[process] = { ...totals };
    }
    const logQueueDropped = cumulative
      .filter((row) => row.module === "logging")
      .reduce((total, row) => total + row.failedWriteOperations, 0);

    return {
      startedAt: this.startedAt,
      sessionStartedAt: this.sessionStartedAt,
      globalTotals: { ...this.globalTotals },
      capturedAt,
      historyIntervalMs: this.options.historyIntervalMs ?? DISK_IO_HISTORY_INTERVAL_MS,
      historyRetentionMs:
        (this.options.historyIntervalMs ?? DISK_IO_HISTORY_INTERVAL_MS) *
        (this.options.historyBuckets ?? DISK_IO_HISTORY_BUCKETS),
      // Linux /proc/self/io 首次读取可能不可用；只有收到有效差值后才对 UI 宣称可用。
      osIoAvailable: this.options.osIoAvailable && this.osIoSampleCount > 0,
      cumulative,
      history,
      osIoCumulative,
      logQueuePending: 0,
      logQueueDropped,
    };
  }
}
