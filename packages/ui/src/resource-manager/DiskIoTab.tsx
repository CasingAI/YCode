import { useEffect, useMemo, useState } from "react";
import {
  type DiskIoMetricRow,
  type DiskIoModule,
  type DiskIoProcess,
  type DiskIoSnapshot,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/index.js";
import { formatBytes } from "./resourceUsageView.js";
import { TrendChart } from "./DiskIoTrendChart.js";
import { DiskIoDetailsTable } from "./DiskIoDetailsTable.js";
import {
  filterDiskIoRows,
  formatDiskIoDuration,
  formatDiskIoP95,
  getDiskIoRateFromLatestBucket,
  summarizeDiskIoRows,
  type DiskIoModuleFilter,
  type DiskIoProcessFilter,
} from "./diskIoView.js";

const DISK_IO_REFRESH_INTERVAL_MS = 5_000;
const DISK_IO_VISIBLE_HISTORY_MS = 5 * 60_000;

const PROCESS_LABEL_IDS: Record<DiskIoProcess, string> = {
  main: "resourceManager.diskIo.process.main",
  host: "resourceManager.diskIo.process.host",
  agent: "resourceManager.diskIo.process.agent",
};
const MODULE_LABEL_IDS: Record<DiskIoModule, string> = {
  logging: "resourceManager.diskIo.module.logging",
  sqlite: "resourceManager.diskIo.module.sqlite",
  cache: "resourceManager.diskIo.module.cache",
  config: "resourceManager.diskIo.module.config",
  session: "resourceManager.diskIo.module.session",
  attachment: "resourceManager.diskIo.module.attachment",
  storage: "resourceManager.diskIo.module.storage",
  filesystem: "resourceManager.diskIo.module.filesystem",
  other: "resourceManager.diskIo.module.other",
};

export interface DiskIoTabProps {
  getDiskIoSnapshot?: () => Promise<DiskIoSnapshot>;
  refreshIntervalMs?: number;
}

interface TrendPoint {
  timestamp: number;
  readRate: number;
  writeRate: number;
  averageLatency: number | null;
  readOperationsPerSecond: number;
  writeOperationsPerSecond: number;
  operationsPerSecond: number;
  logWriteFailures: number;
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function metricRowsForSample(
  rows: readonly DiskIoMetricRow[],
  processFilter: DiskIoProcessFilter,
  moduleFilter: DiskIoModuleFilter,
): DiskIoMetricRow[] {
  return filterDiskIoRows(rows, processFilter, moduleFilter);
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-background-alt/50 px-3 py-2">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-0.5 break-words text-ui-base font-semibold tabular-nums sm:text-ui-lg">
        {value}
      </div>
      {detail ? <div className="mt-0.5 text-ui-xs text-foreground-subtle">{detail}</div> : null}
    </div>
  );
}

export function DiskIoTab({
  getDiskIoSnapshot,
  refreshIntervalMs = DISK_IO_REFRESH_INTERVAL_MS,
}: DiskIoTabProps) {
  const { intl } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<DiskIoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processFilter, setProcessFilter] = useState<DiskIoProcessFilter>("all");
  const [moduleFilter, setModuleFilter] = useState<DiskIoModuleFilter>("all");

  useEffect(() => {
    if (!getDiskIoSnapshot) {
      setError(intl.formatMessage({ id: "resourceManager.unavailable" }));
      return;
    }
    let disposed = false;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getDiskIoSnapshot!();
        if (!disposed) {
          setSnapshot(next);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), refreshIntervalMs);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [getDiskIoSnapshot, intl, refreshIntervalMs]);

  const cumulativeRows = snapshot?.cumulative ?? [];
  const totals = useMemo(() => summarizeDiskIoRows(cumulativeRows), [cumulativeRows]);
  const selectedRows = useMemo(
    () => filterDiskIoRows(cumulativeRows, processFilter, moduleFilter),
    [cumulativeRows, processFilter, moduleFilter],
  );
  const history = useMemo(() => {
    if (!snapshot) return [];
    const cutoff = snapshot.capturedAt - DISK_IO_VISIBLE_HISTORY_MS;
    return snapshot.history.filter((sample) => sample.timestamp >= cutoff);
  }, [snapshot]);
  const points = useMemo<TrendPoint[]>(() => {
    if (!snapshot) return [];
    return history.map((sample) => {
      const rows = metricRowsForSample(sample.rows, processFilter, moduleFilter);
      const summary = summarizeDiskIoRows(rows);
      return {
        timestamp: sample.timestamp,
        readRate: (summary.readBytes * 1_000) / snapshot.historyIntervalMs,
        writeRate: (summary.writeBytes * 1_000) / snapshot.historyIntervalMs,
        averageLatency: summary.averageDurationMs,
        readOperationsPerSecond: (summary.readOperations * 1_000) / snapshot.historyIntervalMs,
        writeOperationsPerSecond: (summary.writeOperations * 1_000) / snapshot.historyIntervalMs,
        operationsPerSecond: (summary.operationCount * 1_000) / snapshot.historyIntervalMs,
        logWriteFailures: rows
          .filter((row) => row.module === "logging")
          .reduce((total, row) => total + row.failedWriteOperations, 0),
      };
    });
  }, [history, moduleFilter, processFilter, snapshot]);

  const peakReadRate = points.reduce((peak, point) => Math.max(peak, point.readRate), 0);
  const peakWriteRate = points.reduce((peak, point) => Math.max(peak, point.writeRate), 0);
  const peakOperationsPerSecond = points.reduce(
    (peak, point) => Math.max(peak, point.operationsPerSecond),
    0,
  );
  const currentReadRate = snapshot
    ? getDiskIoRateFromLatestBucket(snapshot, "read", processFilter, moduleFilter)
    : 0;
  const currentWriteRate = snapshot
    ? getDiskIoRateFromLatestBucket(snapshot, "write", processFilter, moduleFilter)
    : 0;
  const osReadBytes = Object.values(snapshot?.osIoCumulative ?? {}).reduce(
    (sum, item) => sum + (item?.readBytes ?? 0),
    0,
  );
  const osWriteBytes = Object.values(snapshot?.osIoCumulative ?? {}).reduce(
    (sum, item) => sum + (item?.writeBytes ?? 0),
    0,
  );

  const processLabel = (process: DiskIoProcess) =>
    intl.formatMessage({ id: PROCESS_LABEL_IDS[process] });
  const moduleLabel = (module: DiskIoModule) =>
    intl.formatMessage({ id: MODULE_LABEL_IDS[module] });
  const text = (key: string) => intl.formatMessage({ id: `resourceManager.diskIo.${key}` });

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="resource-manager-disk-io">
      {error ? (
        <div
          className="rounded-lg border border-destructive/30 bg-card px-3 py-2 text-ui-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <section className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-ui-base font-semibold">{text("title")}</h2>
          <p className="text-ui-xs text-foreground-subtle">{text("logicalIoNote")}</p>
        </div>
        <span className="text-ui-xs text-foreground-subtle">{text("liveWindow")}</span>
      </section>

      <section className="grid grid-cols-3 gap-2" aria-label={text("globalSinceStart")}>
        <MetricCard
          label={text("readTotal")}
          value={snapshot ? formatBytes(snapshot.globalTotals.readBytes) : "—"}
          detail={`${formatInteger(snapshot?.globalTotals.readOperations ?? 0)} ${text("operations")} · ${text("globalSinceStart")}`}
        />
        <MetricCard
          label={text("writeTotal")}
          value={snapshot ? formatBytes(snapshot.globalTotals.writeBytes) : "—"}
          detail={`${formatInteger(snapshot?.globalTotals.writeOperations ?? 0)} ${text("operations")} · ${text("globalSinceStart")}`}
        />
        <MetricCard
          label={text("failures")}
          value={snapshot ? formatInteger(snapshot.globalTotals.failedOperations) : "—"}
          detail={text("globalSinceStart")}
        />
      </section>

      <section className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
        <div>
          <span className="text-ui-sm font-medium">{text("readWriteTrend")}</span>
        </div>
        <div className="-mx-2 -my-2">
          <TrendChart
            title={text("readWriteTrend")}
            firstLabel={text("readRate")}
            secondLabel={text("writeRate")}
            firstValues={points.map((point) => point.readRate)}
            secondValues={points.map((point) => point.writeRate)}
            firstValueFormatter={formatRate}
            secondValueFormatter={formatRate}
            currentFirstValue={currentReadRate}
            currentSecondValue={currentWriteRate}
            compact
          />
        </div>
      </section>

      <DiskIoDetailsTable
        selectedRows={selectedRows}
        processFilter={processFilter}
        moduleFilter={moduleFilter}
        setProcessFilter={setProcessFilter}
        setModuleFilter={setModuleFilter}
        processLabel={processLabel}
        moduleLabel={moduleLabel}
        text={text}
      />

      <section className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-card px-3 py-2 sm:grid-cols-4">
        <div>
          <div className="text-ui-xs text-foreground-subtle">{text("osReadTotal")}</div>
          <div className="text-ui-sm font-semibold tabular-nums">
            {snapshot?.osIoAvailable ? formatBytes(osReadBytes) : text("unavailable")}
          </div>
        </div>
        <div>
          <div className="text-ui-xs text-foreground-subtle">{text("osWriteTotal")}</div>
          <div className="text-ui-sm font-semibold tabular-nums">
            {snapshot?.osIoAvailable ? formatBytes(osWriteBytes) : text("unavailable")}
          </div>
        </div>
        <div>
          <div className="text-ui-xs text-foreground-subtle">{text("readRate")}</div>
          <div className="text-ui-sm font-semibold tabular-nums">{formatRate(currentReadRate)}</div>
        </div>
        <div>
          <div className="text-ui-xs text-foreground-subtle">{text("writeRate")}</div>
          <div className="text-ui-sm font-semibold tabular-nums">
            {formatRate(currentWriteRate)}
          </div>
        </div>
        <p className="col-span-full text-ui-xs text-foreground-subtle">
          {text("osIoNote")} · {text("latestBucketRate")}
        </p>
      </section>

      <details className="min-w-0 rounded-lg border border-border bg-card p-3">
        <summary className="cursor-pointer text-ui-sm font-medium">
          {text("moreStatistics")}
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          <MetricCard
            label={text("databaseOps")}
            value={formatInteger(totals.databaseOperations)}
          />
          <MetricCard
            label={text("averageLatency")}
            value={formatDiskIoDuration(totals.averageDurationMs)}
          />
          <MetricCard
            label={text("p95Latency")}
            value={formatDiskIoP95(totals)}
            detail={text("p95Approx")}
          />
          <MetricCard
            label={text("peakReadRate")}
            value={formatRate(peakReadRate)}
            detail={text("recentWindowPeak")}
          />
          <MetricCard
            label={text("peakWriteRate")}
            value={formatRate(peakWriteRate)}
            detail={text("recentWindowPeak")}
          />
          <MetricCard
            label={text("peakOperationsPerSecond")}
            value={`${peakOperationsPerSecond.toFixed(1)}/s`}
            detail={text("recentWindowPeak")}
          />
          <MetricCard
            label={text("logQueuePending")}
            value={snapshot ? String(snapshot.logQueuePending) : "—"}
            detail={text("syncLoggerNoQueue")}
          />
          <MetricCard
            label={text("logQueueDropped")}
            value={formatInteger(snapshot?.logQueueDropped ?? 0)}
            detail={text("logWriteFailures")}
          />
        </div>
        <p className="mt-3 text-ui-xs text-foreground-subtle">
          {text("unmeasuredBytesNote")} {formatInteger(totals.unmeasuredReadOperations)} /{" "}
          {formatInteger(totals.unmeasuredWriteOperations)}
        </p>
        <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-2">
          <TrendChart
            title={text("latencyTrend")}
            firstLabel={text("averageLatency")}
            firstValues={points.map((point) => point.averageLatency ?? 0)}
            firstValueFormatter={formatDiskIoDuration}
          />
          <TrendChart
            title={text("operationFrequencyTrend")}
            firstLabel={text("readOperationsPerSecond")}
            secondLabel={text("writeOperationsPerSecond")}
            firstValues={points.map((point) => point.readOperationsPerSecond)}
            secondValues={points.map((point) => point.writeOperationsPerSecond)}
            firstValueFormatter={(value) => `${value.toFixed(1)}/s`}
            secondValueFormatter={(value) => `${value.toFixed(1)}/s`}
          />
          <TrendChart
            title={text("logWriteFailureTrend")}
            firstLabel={text("logQueueDropped")}
            firstValues={points.map((point) => point.logWriteFailures)}
            firstValueFormatter={formatInteger}
          />
        </div>
      </details>
    </div>
  );
}
