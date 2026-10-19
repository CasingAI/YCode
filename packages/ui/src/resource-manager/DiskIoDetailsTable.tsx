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
  diskIoSortValue,
  formatDiskIoDuration,
  formatDiskIoP95,
  sortDiskIoRows,
  summarizeDiskIoRows,
  type DiskIoSortKey,
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
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
            {text("processFilter")}
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-ui-sm text-foreground"
              value={processFilter}
              onChange={(event) => setProcessFilter(event.target.value as DiskIoProcessFilter)}
            >
              <option value="all">{text("allSources")}</option>
              {DISK_IO_PROCESSES.map((process) => (
                <option key={process} value={process}>
                  {processLabel(process)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
            {text("moduleFilter")}
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-ui-sm text-foreground"
              value={moduleFilter}
              onChange={(event) => setModuleFilter(event.target.value as DiskIoModuleFilter)}
            >
              <option value="all">{text("allSources")}</option>
              {DISK_IO_MODULES.map((module) => (
                <option key={module} value={module}>
                  {moduleLabel(module)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="max-h-[440px] overflow-auto">
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
