import { useEffect, useMemo, useState } from "react";
import {
  DISK_IO_MODULES,
  DISK_IO_PROCESSES,
  type DiskIoMetricRow,
  type DiskIoModule,
  type DiskIoProcess,
  type DiskIoSnapshot,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/index.js";
import { formatBytes } from "./resourceUsageView.js";
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
type RangeMinutes = 5 | 15 | 30;

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

function makeLine(values: readonly number[], width: number, height: number, maxValue: number): string {
  if (values.length === 0) return "";
  const padding = 8;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  return values
    .map((value, index) => {
      const x = padding + (values.length <= 1 ? plotWidth / 2 : (index / (values.length - 1)) * plotWidth);
      const y = height - padding - (Math.max(0, value) / maxValue) * plotHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function TrendChart({
  title,
  firstLabel,
  secondLabel,
  firstValues,
  secondValues,
  firstValueFormatter,
  secondValueFormatter,
}: {
  title: string;
  firstLabel: string;
  secondLabel?: string;
  firstValues: readonly number[];
  secondValues?: readonly number[];
  firstValueFormatter: (value: number) => string;
  secondValueFormatter?: (value: number) => string;
}) {
  const width = 720;
  const height = 172;
  const maxValue = Math.max(1, ...firstValues, ...(secondValues ?? []));
  const firstPath = makeLine(firstValues, width, height, maxValue);
  const secondPath = secondValues ? makeLine(secondValues, width, height, maxValue) : "";
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-ui-sm font-medium">{title}</div>
      <svg
        className="block h-40 w-full overflow-visible text-primary"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
        preserveAspectRatio="none"
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="8"
            x2={width - 8}
            y1={height - 8 - fraction * (height - 16)}
            y2={height - 8 - fraction * (height - 16)}
            stroke="currentColor"
            strokeOpacity="0.12"
            strokeWidth="1"
          />
        ))}
        {firstPath ? (
          <path d={firstPath} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        ) : null}
        {secondPath ? (
          <path d={secondPath} fill="none" stroke="var(--color-warning, #d97706)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-ui-xs text-foreground-subtle">
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary" />
          {firstLabel}: {firstValueFormatter(firstValues[firstValues.length - 1] ?? 0)}
        </span>
        {secondLabel && secondValues && secondValueFormatter ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-amber-600" />
            {secondLabel}: {secondValueFormatter(secondValues[secondValues.length - 1] ?? 0)}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-3">
      <div className="text-ui-xs text-foreground-subtle">{label}</div>
      <div className="mt-1 break-words text-ui-lg font-semibold tabular-nums">{value}</div>
      {detail ? <div className="mt-1 text-ui-xs text-foreground-subtle">{detail}</div> : null}
    </div>
  );
}

export function DiskIoTab({ getDiskIoSnapshot, refreshIntervalMs = DISK_IO_REFRESH_INTERVAL_MS }: DiskIoTabProps) {
  const { intl } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<DiskIoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeMinutes, setRangeMinutes] = useState<RangeMinutes>(5);
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
    const cutoff = snapshot.capturedAt - rangeMinutes * 60_000;
    return snapshot.history.filter((sample) => sample.timestamp >= cutoff);
  }, [snapshot, rangeMinutes]);
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
  const peakOperationsPerSecond = points.reduce((peak, point) => Math.max(peak, point.operationsPerSecond), 0);
  const currentReadRate = snapshot ? getDiskIoRateFromLatestBucket(snapshot, "read") : 0;
  const currentWriteRate = snapshot ? getDiskIoRateFromLatestBucket(snapshot, "write") : 0;
  const osReadBytes = Object.values(snapshot?.osIoCumulative ?? {}).reduce((sum, item) => sum + (item?.readBytes ?? 0), 0);
  const osWriteBytes = Object.values(snapshot?.osIoCumulative ?? {}).reduce((sum, item) => sum + (item?.writeBytes ?? 0), 0);

  const processLabel = (process: DiskIoProcess) => intl.formatMessage({ id: PROCESS_LABEL_IDS[process] });
  const moduleLabel = (module: DiskIoModule) => intl.formatMessage({ id: MODULE_LABEL_IDS[module] });
  const text = (key: string) => intl.formatMessage({ id: `resourceManager.diskIo.${key}` });

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="resource-manager-disk-io">
      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div>
          <div className="text-ui-sm font-medium">{text("title")}</div>
          <div className="mt-1 text-ui-xs text-foreground-subtle">{text("logicalIoNote")}</div>
        </div>
        <label className="flex items-center gap-2 text-ui-sm">
          <span className="text-foreground-subtle">{text("timeRange")}</span>
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-ui-sm"
            value={rangeMinutes}
            onChange={(event) => setRangeMinutes(Number(event.target.value) as RangeMinutes)}
          >
            <option value={5}>{text("range5m")}</option>
            <option value={15}>{text("range15m")}</option>
            <option value={30}>{text("range30m")}</option>
          </select>
        </label>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        <MetricCard label={text("readTotal")} value={formatBytes(totals.readBytes)} detail={`${formatInteger(totals.readOperations)} ${text("operations")}`} />
        <MetricCard label={text("writeTotal")} value={formatBytes(totals.writeBytes)} detail={`${formatInteger(totals.writeOperations)} ${text("operations")}`} />
        <MetricCard label={text("readRate")} value={formatRate(currentReadRate)} detail={text("latestBucketRate")} />
        <MetricCard label={text("writeRate")} value={formatRate(currentWriteRate)} detail={text("latestBucketRate")} />
        <MetricCard label={text("databaseOps")} value={formatInteger(totals.databaseOperations)} />
        <MetricCard label={text("averageLatency")} value={formatDiskIoDuration(totals.averageDurationMs)} />
        <MetricCard label={text("p95Latency")} value={formatDiskIoP95(totals)} detail={text("p95Approx")} />
        <MetricCard label={text("failures")} value={formatInteger(totals.failedOperations)} />
        <MetricCard label={text("peakReadRate")} value={formatRate(peakReadRate)} detail={text("selectedRangePeak")} />
        <MetricCard label={text("peakWriteRate")} value={formatRate(peakWriteRate)} detail={text("selectedRangePeak")} />
        <MetricCard label={text("peakOperationsPerSecond")} value={`${peakOperationsPerSecond.toFixed(1)}/s`} detail={text("selectedRangePeak")} />
        <MetricCard
          label={text("logQueuePending")}
          value={snapshot ? String(snapshot.logQueuePending) : "—"}
          detail={text("syncLoggerNoQueue")}
        />
        <MetricCard label={text("logQueueDropped")} value={formatInteger(snapshot?.logQueueDropped ?? 0)} detail={text("logWriteFailures")} />
        <MetricCard
          label={text("osReadTotal")}
          value={snapshot?.osIoAvailable ? formatBytes(osReadBytes) : text("unavailable")}
          detail={text("osIoNote")}
        />
        <MetricCard
          label={text("osWriteTotal")}
          value={snapshot?.osIoAvailable ? formatBytes(osWriteBytes) : text("unavailable")}
          detail={text("osIoNote")}
        />
      </section>

      <section className="grid min-w-0 gap-4 xl:grid-cols-2">
        <TrendChart
          title={text("readWriteTrend")}
          firstLabel={text("readRate")}
          secondLabel={text("writeRate")}
          firstValues={points.map((point) => point.readRate)}
          secondValues={points.map((point) => point.writeRate)}
          firstValueFormatter={formatRate}
          secondValueFormatter={formatRate}
        />
        <TrendChart
          title={text("latencyTrend")}
          firstLabel={text("averageLatency")}
          firstValues={points.map((point) => point.averageLatency ?? 0)}
          firstValueFormatter={(value) => formatDiskIoDuration(value)}
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
          firstValueFormatter={(value) => formatInteger(value)}
        />
      </section>

      <section className="min-w-0 rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-ui-sm font-medium">{text("sourceDetails")}</div>
            <div className="mt-1 text-ui-xs text-foreground-subtle">
              {text("unmeasuredBytesNote")} {formatInteger(totals.unmeasuredReadOperations)} / {formatInteger(totals.unmeasuredWriteOperations)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
              <span>{text("processFilter")}</span>
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-ui-sm text-foreground"
                value={processFilter}
                onChange={(event) => setProcessFilter(event.target.value as DiskIoProcessFilter)}
              >
                <option value="all">{text("allSources")}</option>
                {DISK_IO_PROCESSES.map((process) => <option key={process} value={process}>{processLabel(process)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
              <span>{text("moduleFilter")}</span>
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-ui-sm text-foreground"
                value={moduleFilter}
                onChange={(event) => setModuleFilter(event.target.value as DiskIoModuleFilter)}
              >
                <option value="all">{text("allSources")}</option>
                {DISK_IO_MODULES.map((module) => <option key={module} value={module}>{moduleLabel(module)}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-ui-sm">
            <thead>
              <tr className="border-b border-border text-ui-xs text-foreground-subtle">
                <th className="px-2 py-2 font-medium">{text("processFilter")}</th>
                <th className="px-2 py-2 font-medium">{text("moduleFilter")}</th>
                <th className="px-2 py-2 text-right font-medium">{text("operations")}</th>
                <th className="px-2 py-2 text-right font-medium">{text("readTotal")}</th>
                <th className="px-2 py-2 text-right font-medium">{text("writeTotal")}</th>
                <th className="px-2 py-2 text-right font-medium">{text("averageLatency")}</th>
                <th className="px-2 py-2 text-right font-medium">{text("p95Latency")}</th>
                <th className="px-2 py-2 text-right font-medium">{text("failures")}</th>
              </tr>
            </thead>
            <tbody>
              {selectedRows.length === 0 ? (
                <tr><td colSpan={8} className="px-2 py-8 text-center text-foreground-subtle">{text("noData")}</td></tr>
              ) : selectedRows.map((row) => {
                const summary = summarizeDiskIoRows([row]);
                return (
                  <tr key={`${row.process}:${row.module}`} className="border-b border-border/60 last:border-0">
                    <td className="px-2 py-2">{processLabel(row.process)}</td>
                    <td className="px-2 py-2">{moduleLabel(row.module)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatInteger(summary.operationCount)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatBytes(row.readBytes)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatBytes(row.writeBytes)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatDiskIoDuration(summary.averageDurationMs)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatDiskIoP95(summary)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatInteger(row.failedOperations)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
