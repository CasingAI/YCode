import type { ResourceUsageSnapshot } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { formatBytes, formatPercent } from "./resourceUsageView.js";
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
}: {
  rows: readonly OverviewFooterRow[];
  label: string;
  testId: string;
}) {
  return (
    <section
      className="flex min-w-0 flex-col justify-center px-3 py-2"
      aria-label={label}
      data-testid={testId}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-2 border-b border-border/70 py-1 last:border-b-0"
        >
          <span className="truncate text-ui-sm text-foreground-subtle">{row.label}</span>
          <strong className="shrink-0 text-ui-sm font-medium tabular-nums">{row.value}</strong>
        </div>
      ))}
    </section>
  );
}

/**
 * 窗口底部的资源概览栏：左侧关键数值、中间双线趋势、右侧补充数值。
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
}) {
  const scale = resolveOverviewMaxValue(series, maxValue);
  return (
    <footer
      className="h-36 shrink-0 border-t border-border bg-header px-4 py-3"
      data-testid={testId}
      aria-label={ariaLabel}
    >
      <div className="mx-auto grid h-full max-w-5xl grid-cols-[minmax(145px,1fr)_minmax(180px,1.2fr)_minmax(145px,1fr)] rounded-lg border border-border-contrast/40 bg-background-alt/40">
        <OverviewRows rows={rows} label={usageLabel} testId={`${testId}-usage`} />

        <section
          className="min-w-0 border-x border-border px-3 py-2"
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
          <div className="mt-1 flex justify-center gap-4 text-ui-xs text-foreground-subtle">
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
}: {
  snapshot: ResourceUsageSnapshot | null;
  samples: readonly ResourceManagerSample[];
  text: (key: string) => string;
}) {
  const systemCpuPercent = snapshot?.system.cpuPercent ?? 0;
  const appCpuPercent = snapshot?.app.cpuPercent ?? 0;
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
      rows={[
        {
          label: text("cpuFooter.system"),
          value: snapshot ? formatPercent(systemCpuPercent) : EMPTY_VALUE,
        },
        {
          label: text("cpuFooter.app"),
          value: snapshot ? formatPercent(appCpuPercent) : EMPTY_VALUE,
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
}: {
  snapshot: ResourceUsageSnapshot | null;
  samples: readonly ResourceManagerSample[];
  text: (key: string) => string;
}) {
  const totalBytes = snapshot?.system.memoryTotalBytes ?? 0;
  const usedBytes = snapshot?.system.memoryUsedBytes ?? 0;
  const appBytes = snapshot?.app.memoryBytes ?? 0;
  const systemMemoryPercent = toMemoryPercent(usedBytes, totalBytes);
  const freeBytes = Math.max(0, totalBytes - usedBytes);

  return (
    <ResourceManagerOverviewFooter
      testId="resource-manager-memory-footer"
      ariaLabel={text("memoryFooter.summary")}
      usageLabel={text("memoryFooter.usage")}
      statsLabel={text("memoryFooter.processes")}
      trendTitle={text("memoryFooter.trend")}
      trendAriaLabel={text("memoryFooter.trendDescription")}
      maxValue={100}
      rows={[
        {
          label: text("memoryFooter.system"),
          value: snapshot ? formatPercent(systemMemoryPercent) : EMPTY_VALUE,
        },
        {
          label: text("memoryFooter.app"),
          value: snapshot ? formatBytes(appBytes) : EMPTY_VALUE,
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
