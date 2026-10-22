import { Fragment, useMemo, useState } from "react";
import {
  DISK_IO_MODULES,
  DISK_IO_PROCESSES,
  type DiskIoMetricRow,
  type DiskIoModule,
  type DiskIoProcess,
} from "@zcode/shared";
import { formatBytes } from "./resourceUsageView.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  diskIoSortValue,
  formatDiskIoDuration,
  formatDiskIoP95,
  sortDiskIoRows,
  summarizeDiskIoRows,
  type DiskIoSortKey,
  type DiskIoSummary,
  type DiskIoProcessFilter,
  type DiskIoModuleFilter,
} from "./diskIoView.js";

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

interface DiskIoDetailsTableProps {
  selectedRows: readonly DiskIoMetricRow[];
  processFilter: DiskIoProcessFilter;
  moduleFilter: DiskIoModuleFilter;
  setProcessFilter: (filter: DiskIoProcessFilter) => void;
  setModuleFilter: (filter: DiskIoModuleFilter) => void;
  processLabel: (process: DiskIoProcess) => string;
  moduleLabel: (module: DiskIoModule) => string;
  text: (key: string) => string;
}

function MobileMetrics({
  summary,
  text,
}: {
  summary: DiskIoSummary;
  text: (key: string) => string;
}) {
  const values = [
    ["operations", formatInteger(summary.operationCount)],
    ["readTotal", formatBytes(summary.readBytes)],
    ["writeTotal", formatBytes(summary.writeBytes)],
    ["averageLatency", formatDiskIoDuration(summary.averageDurationMs)],
    ["failures", formatInteger(summary.failedOperations)],
    ["p95Latency", formatDiskIoP95(summary)],
  ] as const;
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 px-3 pb-3 text-ui-sm">
      {values.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="break-words text-ui-xs text-foreground-subtle">{text(label)}</dt>
          <dd className="break-words tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 会话明细按进程汇总，并支持排序、展开模块及来源筛选。 */
export function DiskIoDetailsTable({
  selectedRows,
  processFilter,
  moduleFilter,
  setProcessFilter,
  setModuleFilter,
  processLabel,
  moduleLabel,
  text,
}: DiskIoDetailsTableProps) {
  const [sortKey, setSortKey] = useState<DiskIoSortKey>("readBytes");
  const [sortDescending, setSortDescending] = useState(true);
  const [collapsedProcesses, setCollapsedProcesses] = useState<DiskIoProcess[]>([]);
  const groupedRows = useMemo(
    () =>
      DISK_IO_PROCESSES.map((process) => ({
        process,
        rows: sortDiskIoRows(
          selectedRows.filter((row) => row.process === process),
          sortKey,
          sortDescending,
        ),
      }))
        .filter((group) => group.rows.length > 0)
        .sort((left, right) => {
          const delta = diskIoSortValue(left.rows, sortKey) - diskIoSortValue(right.rows, sortKey);
          return (sortDescending ? -delta : delta) || left.process.localeCompare(right.process);
        }),
    [selectedRows, sortKey, sortDescending],
  );
  const setSort = (key: DiskIoSortKey) => {
    if (key === sortKey) setSortDescending((previous) => !previous);
    else {
      setSortKey(key);
      setSortDescending(true);
    }
  };
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-ui-sm font-medium">{text("sourceDetails")}</h3>
          <p className="text-ui-xs text-foreground-subtle">{text("sessionOnly")}</p>
        </div>
        <div className="grid w-full min-w-0 grid-cols-1 gap-2 min-[360px]:grid-cols-2 md:flex md:w-auto md:flex-wrap">
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-xs text-foreground-subtle md:flex-row md:items-center">
            {text("processFilter")}
            <Select
              value={processFilter}
              onValueChange={(value) => setProcessFilter(value as DiskIoProcessFilter)}
            >
              <SelectTrigger
                aria-label={text("processFilter")}
                className="h-11 w-full min-w-0 bg-background text-ui-sm md:h-8 md:w-auto"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{text("allSources")}</SelectItem>
                {DISK_IO_PROCESSES.map((process) => (
                  <SelectItem key={process} value={process}>
                    {processLabel(process)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-ui-xs text-foreground-subtle md:flex-row md:items-center">
            {text("moduleFilter")}
            <Select
              value={moduleFilter}
              onValueChange={(value) => setModuleFilter(value as DiskIoModuleFilter)}
            >
              <SelectTrigger
                aria-label={text("moduleFilter")}
                className="h-11 w-full min-w-0 bg-background text-ui-sm md:h-8 md:w-auto"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{text("allSources")}</SelectItem>
                {DISK_IO_MODULES.map((module) => (
                  <SelectItem key={module} value={module}>
                    {moduleLabel(module)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      </div>
      {/* 手机按来源展开详情，避免七列表格制造内层横向与纵向滚动。排序和分组仍由同一状态持有。 */}
      <div className="md:hidden" data-testid="disk-io-mobile-sources">
        <div className="mb-3 flex min-w-0 items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-ui-xs text-foreground-subtle">
            {text("sortBy")}
            <Select value={sortKey} onValueChange={(value) => setSort(value as DiskIoSortKey)}>
              <SelectTrigger aria-label={text("sortBy")} className="h-11 w-full min-w-0 text-ui-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  [
                    ["operations", "operations"],
                    ["readBytes", "readTotal"],
                    ["writeBytes", "writeTotal"],
                    ["averageLatency", "averageLatency"],
                    ["failedOperations", "failures"],
                  ] as const
                ).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {text(label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <button
            type="button"
            className="min-h-11 shrink-0 rounded-md border border-border px-3 text-ui-sm hover:bg-hover"
            onClick={() => setSortDescending((previous) => !previous)}
          >
            {text(sortDescending ? "sortDescending" : "sortAscending")}
          </button>
        </div>
        {groupedRows.length === 0 ? (
          <p className="py-4 text-center text-ui-sm text-foreground-subtle">{text("noData")}</p>
        ) : (
          groupedRows.map(({ process, rows }) => {
            const summary = summarizeDiskIoRows(rows);
            const collapsed = collapsedProcesses.includes(process);
            return (
              <div key={process} className="border-t border-border">
                <button
                  type="button"
                  className="flex min-h-11 w-full min-w-0 items-center gap-2 py-2 text-left text-ui-sm font-medium"
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setCollapsedProcesses((previous) =>
                      collapsed
                        ? previous.filter((item) => item !== process)
                        : [...previous, process],
                    )
                  }
                >
                  <span aria-hidden="true" className="shrink-0">
                    {collapsed ? "▸" : "▾"}
                  </span>
                  <span className="min-w-0 break-words">{processLabel(process)}</span>
                </button>
                {!collapsed ? (
                  <>
                    <MobileMetrics summary={summary} text={text} />
                    {rows.map((row) => (
                      <details key={row.module} className="border-t border-border/50">
                        <summary className="min-h-11 cursor-pointer break-words py-3 text-ui-sm text-foreground-subtle">
                          {moduleLabel(row.module)}
                        </summary>
                        <MobileMetrics summary={summarizeDiskIoRows([row])} text={text} />
                      </details>
                    ))}
                  </>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      <div
        className="hidden max-h-[440px] overflow-auto md:block"
        data-testid="disk-io-desktop-sources"
      >
        <table className="w-full min-w-[720px] border-collapse text-left text-ui-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-ui-xs text-foreground-subtle">
              <th className="px-2 py-2 font-medium">
                {text("processFilter")} / {text("moduleFilter")}
              </th>
              {(
                [
                  ["operations", "operations"],
                  ["readBytes", "readTotal"],
                  ["writeBytes", "writeTotal"],
                  ["averageLatency", "averageLatency"],
                  ["failedOperations", "failures"],
                ] as const
              ).map(([key, label]) => (
                <th
                  key={key}
                  className="px-2 py-2 text-right font-medium"
                  aria-sort={
                    sortKey === key ? (sortDescending ? "descending" : "ascending") : "none"
                  }
                >
                  <button
                    type="button"
                    className="whitespace-nowrap hover:text-foreground"
                    onClick={() => setSort(key)}
                  >
                    {text(label)} {sortKey === key ? (sortDescending ? "↓" : "↑") : ""}
                  </button>
                </th>
              ))}
              <th className="px-2 py-2 text-right font-medium">{text("p95Latency")}</th>
            </tr>
          </thead>
          <tbody>
            {groupedRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-8 text-center text-foreground-subtle">
                  {text("noData")}
                </td>
              </tr>
            ) : (
              groupedRows.map(({ process, rows }) => {
                const summary = summarizeDiskIoRows(rows);
                const collapsed = collapsedProcesses.includes(process);
                return (
                  <Fragment key={process}>
                    <tr className="border-b border-border bg-background-alt/70 font-medium">
                      <td className="py-1.5 pl-2">
                        <button
                          type="button"
                          aria-expanded={!collapsed}
                          className="flex items-center gap-2 hover:text-primary"
                          onClick={() =>
                            setCollapsedProcesses((previous) =>
                              collapsed
                                ? previous.filter((item) => item !== process)
                                : [...previous, process],
                            )
                          }
                        >
                          <span className="w-3 text-ui-xs text-foreground-subtle">
                            {collapsed ? "▸" : "▾"}
                          </span>
                          {processLabel(process)}
                        </button>
                      </td>
                      <td className="px-2 text-right tabular-nums">
                        {formatInteger(summary.operationCount)}
                      </td>
                      <td className="px-2 text-right tabular-nums">
                        {formatBytes(summary.readBytes)}
                      </td>
                      <td className="px-2 text-right tabular-nums">
                        {formatBytes(summary.writeBytes)}
                      </td>
                      <td className="px-2 text-right tabular-nums">
                        {formatDiskIoDuration(summary.averageDurationMs)}
                      </td>
                      <td
                        className={`px-2 text-right tabular-nums ${summary.failedOperations > 0 ? "text-destructive" : ""}`}
                      >
                        {formatInteger(summary.failedOperations)}
                      </td>
                      <td className="px-2 text-right tabular-nums">{formatDiskIoP95(summary)}</td>
                    </tr>
                    {!collapsed &&
                      rows.map((row) => {
                        const item = summarizeDiskIoRows([row]);
                        return (
                          <tr
                            key={`${process}:${row.module}`}
                            className="border-b border-border/50 last:border-0 hover:bg-hover/60"
                          >
                            <td className="py-1.5 pl-7 text-foreground-subtle">
                              {moduleLabel(row.module)}
                            </td>
                            <td className="px-2 text-right tabular-nums">
                              {formatInteger(item.operationCount)}
                            </td>
                            <td className="px-2 text-right tabular-nums">
                              {formatBytes(row.readBytes)}
                            </td>
                            <td className="px-2 text-right tabular-nums">
                              {formatBytes(row.writeBytes)}
                            </td>
                            <td className="px-2 text-right tabular-nums">
                              {formatDiskIoDuration(item.averageDurationMs)}
                            </td>
                            <td
                              className={`px-2 text-right tabular-nums ${row.failedOperations > 0 ? "text-destructive" : ""}`}
                            >
                              {formatInteger(row.failedOperations)}
                            </td>
                            <td className="px-2 text-right tabular-nums">
                              {formatDiskIoP95(item)}
                            </td>
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
