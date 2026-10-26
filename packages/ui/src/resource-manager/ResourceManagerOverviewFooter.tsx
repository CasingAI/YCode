import type { ReactNode } from "react";
import type { ResourceUsageSnapshot } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  formatBytes,
  formatPercent,
  isResourceUsageSnapshotComplete,
} from "./resourceUsageView.js";
import {
  buildOverviewTrendPath,
  resolveOverviewMaxValue,
  toMemoryPercent,
  type OverviewSeries,
  type ResourceManagerSample,
} from "./resourceOverviewView.js";

/** 概览底栏的一行「名称 + 数值」。 */
export interface OverviewFooterRow {
  label: string;
  value: string;
}

const TONE_STROKE: Record<OverviewSeries["tone"], string> = {
  primary: "var(--color-primary)",
  warning: "var(--color-warning)",
};

const TONE_DOT: Record<OverviewSeries["tone"], string> = {
  primary: "bg-primary",
  warning: "bg-warning",
};

function OverviewRows({
  rows,
  label,
  testId,
  className,
}: {
  rows: readonly OverviewFooterRow[];
  label: string;
  testId: string;
  className?: string;
}) {
  return (
    <section
      className={cn("flex min-w-0 flex-col justify-center px-3 py-2", className)}
      aria-label={label}
      data-testid={testId}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border/70 py-1 last:border-b-0"
        >
          <span className="min-w-0 break-words text-ui-sm text-foreground-subtle">{row.label}</span>
          <strong className="max-w-full break-words text-ui-sm font-medium tabular-nums">
            {row.value}
          </strong>
        </div>
      ))}
    </section>
  );
}

/**
 * 宽屏是底部三栏概览，窄屏进入正文并按摘要、趋势、补充数值排列。
 * 纯展示组件，不持有指标状态，也不负责采样。
 */
export function ResourceManagerOverviewFooter({
  testId,
  ariaLabel,
  usageLabel,
  statsLabel,
  rows,
  stats,
  series,
  trendTitle,
  trendAriaLabel,
  maxValue,
  mobileSummary,
}: {
  testId: string;
  ariaLabel: string;
  usageLabel: string;
  statsLabel: string;
  rows: readonly OverviewFooterRow[];
  stats: readonly OverviewFooterRow[];
  series: readonly OverviewSeries[];
  trendTitle: string;
  trendAriaLabel: string;
  /** 固定纵轴上限（百分比曲线传 100），缺省按峰值自适应 */
  maxValue?: number;
  /** 窄屏复用当前指标卡，避免和底栏的使用量行重复展示同一份数值。 */
  mobileSummary?: ReactNode;
}) {
  const scale = resolveOverviewMaxValue(series, maxValue);
  return (
    <footer
      className="min-w-0 shrink-0 px-4 py-3 md:h-36 md:border-t md:border-border md:bg-header"
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {mobileSummary ? (
        <div className="mb-4 md:hidden" data-testid={`${testId}-mobile-summary`}>
          {mobileSummary}
        </div>
      ) : null}
      {/* 原三栏的最小宽度超过手机视口；仅在宽屏恢复三栏，窄屏保持同一份概览的自然文档流。 */}
      <div className="mx-auto grid min-w-0 max-w-5xl gap-3 md:h-full md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)] md:gap-0 md:rounded-lg md:border md:border-border-contrast/40 md:bg-background-alt/40">
        <OverviewRows
          rows={rows}
          label={usageLabel}
          testId={`${testId}-usage`}
          className={mobileSummary ? "hidden md:flex" : undefined}
        />

        <section
          className="min-w-0 rounded-lg border border-border bg-card px-3 py-2 md:rounded-none md:border-x md:border-y-0 md:bg-transparent"
          aria-label={trendTitle}
          data-testid={`${testId}-trend`}
        >
          <h2 className="mb-1 text-center text-ui-xs font-medium text-foreground-subtle">
            {trendTitle}
          </h2>
          <svg
            className="block h-16 w-full"
            viewBox="0 0 420 76"
            preserveAspectRatio="none"
            role="img"
            aria-label={trendAriaLabel}
          >
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                key={fraction}
                x1="4"
                x2="416"
                y1={76 - 4 - fraction * 68}
                y2={76 - 4 - fraction * 68}
                stroke="var(--color-border)"
                strokeOpacity="0.6"
                strokeWidth="1"
              />
            ))}
            {series.map((item) => {
              const path = buildOverviewTrendPath(item.values, scale);
              if (!path) return null;
              return (
                <path
                  key={item.label}
                  d={path}
                  fill="none"
                  stroke={TONE_STROKE[item.tone]}
                  strokeWidth="2"
                />
              );
            })}
          </svg>
          <div className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1 text-ui-xs text-foreground-subtle">
            {series.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", TONE_DOT[item.tone])} />
                {item.label}
              </span>
            ))}
          </div>
        </section>

        <OverviewRows rows={stats} label={statsLabel} testId={`${testId}-stats`} />
      </div>
    </footer>
  );
}

const EMPTY_VALUE = "—";

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

/** CPU 页底栏：整机 CPU、YCode CPU、空闲比例 + CPU 趋势 + 进程数与逻辑核数。 */
export function ResourceManagerCpuFooter({
  snapshot,
  samples,
  text,
  mobileSummary,
}: {
  snapshot: ResourceUsageSnapshot | null;
  samples: readonly ResourceManagerSample[];
  text: (key: string) => string;
  mobileSummary?: ReactNode;
}) {
  const systemCpuPercent = snapshot?.system.cpuPercent ?? 0;
  const appCpuPercent = snapshot?.app.cpuPercent ?? 0;
  // 整机与空闲比例仍来自有效系统采样；只有 YCode 合计依赖完整进程采样。
  const appComplete = isResourceUsageSnapshotComplete(snapshot);
  const idlePercent = Math.max(0, 100 - Math.min(100, systemCpuPercent));

  return (
    <ResourceManagerOverviewFooter
      testId="resource-manager-cpu-footer"
      ariaLabel={text("cpuFooter.summary")}
      usageLabel={text("cpuFooter.usage")}
      statsLabel={text("cpuFooter.processes")}
      trendTitle={text("cpuFooter.trend")}
      trendAriaLabel={text("cpuFooter.trendDescription")}
      maxValue={100}
      mobileSummary={mobileSummary}
      rows={[
        {
          label: text("cpuFooter.system"),
          value: snapshot ? formatPercent(systemCpuPercent) : EMPTY_VALUE,
        },
        {
          label: text("cpuFooter.app"),
          value: appComplete ? formatPercent(appCpuPercent) : EMPTY_VALUE,
        },
        {
          label: text("cpuFooter.idle"),
          value: snapshot ? formatPercent(idlePercent) : EMPTY_VALUE,
        },
      ]}
      stats={[
        {
          label: text("cpuFooter.processes"),
          value: snapshot ? formatCount(snapshot.processes.length) : EMPTY_VALUE,
        },
        {
          label: text("cpuFooter.logicalCpus"),
          value: snapshot ? formatCount(snapshot.logicalCpuCount) : EMPTY_VALUE,
        },
      ]}
      series={[
        {
          label: text("cpuFooter.system"),
          values: samples.map((sample) => sample.systemCpuPercent),
          tone: "primary",
        },
        {
          label: text("cpuFooter.app"),
          values: samples.map((sample) => sample.appCpuPercent),
          tone: "warning",
        },
      ]}
    />
  );
}

/** 内存页底栏：整机内存占用、YCode 内存、空闲内存 + 内存趋势 + 进程数与物理内存。 */
export function ResourceManagerMemoryFooter({
  snapshot,
  samples,
  text,
  mobileSummary,
}: {
  snapshot: ResourceUsageSnapshot | null;
  samples: readonly ResourceManagerSample[];
  text: (key: string) => string;
  mobileSummary?: ReactNode;
}) {
  const totalBytes = snapshot?.system.memoryTotalBytes ?? 0;
  const usedBytes = snapshot?.system.memoryUsedBytes ?? 0;
  const appBytes = snapshot?.app.memoryBytes ?? 0;
  const systemMemoryPercent = toMemoryPercent(usedBytes, totalBytes);
  const freeBytes = Math.max(0, totalBytes - usedBytes);
  const appComplete = isResourceUsageSnapshotComplete(snapshot);

  return (
    <ResourceManagerOverviewFooter
      testId="resource-manager-memory-footer"
      ariaLabel={text("memoryFooter.summary")}
      usageLabel={text("memoryFooter.usage")}
      statsLabel={text("memoryFooter.processes")}
      trendTitle={text("memoryFooter.trend")}
      trendAriaLabel={text("memoryFooter.trendDescription")}
      maxValue={100}
      mobileSummary={mobileSummary}
      rows={[
        {
          label: text("memoryFooter.system"),
          value: snapshot ? formatPercent(systemMemoryPercent) : EMPTY_VALUE,
        },
        {
          label: text("memoryFooter.app"),
          value: appComplete ? formatBytes(appBytes) : EMPTY_VALUE,
        },
        {
          label: text("memoryFooter.idle"),
          value: snapshot ? formatBytes(freeBytes) : EMPTY_VALUE,
        },
      ]}
      stats={[
        {
          label: text("memoryFooter.processes"),
          value: snapshot ? formatCount(snapshot.processes.length) : EMPTY_VALUE,
        },
        {
          label: text("memoryFooter.totalMemory"),
          value: snapshot ? formatBytes(totalBytes) : EMPTY_VALUE,
        },
      ]}
      series={[
        {
          label: text("memoryFooter.system"),
          values: samples.map((sample) => sample.systemMemoryPercent),
          tone: "primary",
        },
        {
          label: text("memoryFooter.app"),
          values: samples.map((sample) => sample.appMemoryPercent),
          tone: "warning",
        },
      ]}
    />
  );
}
