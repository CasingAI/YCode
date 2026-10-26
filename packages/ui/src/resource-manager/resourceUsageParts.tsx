/**
 * 资源管理器 CPU / 内存 tab 的展示零件：双列指标卡、分组列表、进程行。
 * 只做格式化与布局，不持有任何指标状态。
 */
import { ChevronRight } from "lucide-react";
import type { ResourceUsageProcess } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { formatBytes, formatPercent, type ResourceUsageGroupView } from "./resourceUsageView.js";

export const UNSAMPLED_PLACEHOLDER = "—";

type UsageMetric = "cpu" | "memory";

interface UsageMeterProps {
  testId: string;
  label: string;
  appValue: string;
  systemValue: string;
  appPercent: number;
  systemPercent: number;
  appLabel: string;
  systemLabel: string;
}

/** 整机与 YCode 使用同一口径的独立指标，文字和进度条共同说明占用。 */
export function UsageMeter({
  testId,
  label,
  appValue,
  systemValue,
  appPercent,
  systemPercent,
  appLabel,
  systemLabel,
}: UsageMeterProps) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-card p-4" data-testid={testId}>
      <div className="text-ui-sm font-medium text-foreground-subtle">{label}</div>
      {/* 原先的单行数值和共享图例会被长内存文本撑开；两列各自允许收缩和换行。 */}
      <div className="mt-3 grid min-w-0 grid-cols-2 gap-4">
        {[
          { key: "system", label: systemLabel, value: systemValue, percent: systemPercent },
          { key: "app", label: appLabel, value: appValue, percent: appPercent },
        ].map((item) => (
          <div key={item.key} className="min-w-0">
            <div className="break-words text-ui-xs text-foreground-subtle">{item.label}</div>
            <span
              className="mt-1 block font-mono text-ui-xl font-medium [overflow-wrap:anywhere]"
              data-testid={`${testId}-${item.key}`}
            >
              {item.value}
            </span>
            <div
              className="mt-2 h-1 overflow-hidden rounded-sm bg-surface-hover"
              role="img"
              aria-label={`${item.label} ${item.value}`}
            >
              <div
                className={cn(
                  "h-full rounded-sm",
                  item.key === "app" ? "bg-brand" : "bg-foreground-subtlest/40",
                )}
                style={{ width: `${item.percent}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface UsageGroupProps {
  group: ResourceUsageGroupView;
  metric: UsageMetric;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  emptyText: string;
  samplingText: string;
  columns: { process: string; pid: string; cpu: string; memory: string };
}

const ROW_GRID_CLASS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 md:grid-cols-[minmax(0,1fr)_72px_96px] md:items-center";

export function UsageGroup({
  group,
  metric,
  title,
  expanded,
  onToggle,
  emptyText,
  samplingText,
  columns,
}: UsageGroupProps) {
  // 分组卡片保持内容自然高度：父进程列表负责滚动，卡片被 flex 收缩会裁切内部进程行。
  return (
    <div
      className="shrink-0 overflow-hidden rounded-xl border border-card-border bg-card"
      data-testid={`resource-manager-group-${group.category}`}
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover md:min-h-9 md:py-1 pointer-coarse:min-h-11"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-foreground-subtle transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{title}</span>
        <span className="rounded-sm bg-tag px-1.5 text-ui-xs text-foreground-subtle">
          {group.processCount}
        </span>
        <span
          className="shrink-0 text-right font-mono text-ui-sm text-foreground-subtle md:w-24"
          data-testid={`resource-manager-group-total-${group.category}`}
        >
          {group.hasUnsampled
            ? UNSAMPLED_PLACEHOLDER
            : metric === "cpu"
              ? formatPercent(group.cpuPercent)
              : formatBytes(group.memoryBytes)}
        </span>
      </button>
      {expanded ? (
        group.processes.length === 0 ? (
          <div className="border-t border-border px-3 py-2 text-ui-sm text-foreground-subtlest">
            {emptyText}
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="hidden h-7 grid-cols-[minmax(0,1fr)_72px_96px] items-center gap-2 border-b border-border px-3 text-ui-xs font-medium text-foreground-subtle md:grid">
              <div>{columns.process}</div>
              <div className="text-right">{columns.pid}</div>
              <div className="text-right">{metric === "cpu" ? columns.cpu : columns.memory}</div>
            </div>
            {group.processes.map((process) => (
              <ProcessRow
                key={process.pid}
                process={process}
                metric={metric}
                samplingText={samplingText}
                pidLabel={columns.pid}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function ProcessRow({
  process,
  metric,
  samplingText,
  pidLabel,
}: {
  process: ResourceUsageProcess;
  metric: UsageMetric;
  samplingText: string;
  pidLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const sessionTitle = process.sessionTitle?.trim();
  const sessionTooltip = sessionTitle
    ? intl.formatMessage({ id: "resourceManager.processSession" }, { title: sessionTitle })
    : undefined;
  return (
    <div
      className={cn(
        ROW_GRID_CLASS,
        "min-h-11 border-b border-border px-3 py-2 text-ui-sm last:border-b-0 md:min-h-8 md:py-1",
      )}
      data-testid="resource-manager-process-row"
      data-process-name={process.name}
    >
      {/* 手机让名称和来源参与外层网格，宽屏恢复同一行；不复制来源节点。 */}
      <div className="contents md:col-start-1 md:row-start-1 md:block md:min-w-0">
        <div
          className="contents md:flex md:min-w-0 md:items-baseline md:gap-1.5"
          data-testid="resource-manager-process-identity"
        >
          <span
            className="col-span-2 col-start-1 row-start-1 min-w-0 font-medium text-foreground [overflow-wrap:anywhere] md:max-w-full md:shrink-0 md:truncate"
            title={process.name}
          >
            {process.name}
          </span>
          {sessionTitle ? (
            <span
              className="col-span-2 col-start-2 row-start-2 min-w-0 text-ui-xs text-foreground-subtlest [overflow-wrap:anywhere] md:truncate"
              title={sessionTooltip}
              data-testid="resource-manager-process-session"
            >
              · {sessionTitle}
            </span>
          ) : null}
        </div>
        {process.category !== "base" || !process.sampled ? (
          // 手机分类跟在 PID / 来源之后；宽屏回到名称列第二行，避免覆盖独立指标列。
          <div
            className={cn(
              "col-span-2 col-start-2 min-w-0 text-ui-xs text-foreground-subtlest [overflow-wrap:anywhere] md:col-span-1 md:col-start-1 md:row-start-2",
              sessionTitle ? "row-start-3" : "row-start-2",
            )}
          >
            {process.category !== "base" ? (
              <span className="block md:truncate" title={process.groupLabel}>
                {process.groupLabel}
              </span>
            ) : null}
            {!process.sampled ? <span className="block">{samplingText}</span> : null}
          </div>
        ) : null}
      </div>
      <span
        className="col-start-1 row-start-2 font-mono text-ui-xs text-foreground-subtlest md:col-start-2 md:row-start-1 md:text-right"
        data-testid="resource-manager-process-pid"
      >
        <span className="md:hidden">{pidLabel}</span> {process.pid}
      </span>
      <div
        className="col-start-3 row-start-1 text-right font-mono text-foreground-subtle"
        title={process.sampled ? undefined : samplingText}
      >
        {!process.sampled
          ? UNSAMPLED_PLACEHOLDER
          : metric === "cpu"
            ? formatPercent(process.cpuPercent)
            : formatBytes(process.memoryBytes)}
      </div>
    </div>
  );
}
