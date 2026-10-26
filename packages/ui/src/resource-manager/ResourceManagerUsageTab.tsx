import type { ReactNode } from "react";
import type { ResourceUsageCategory, ResourceUsageSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/index.js";
import { UNSAMPLED_PLACEHOLDER, UsageGroup, UsageMeter } from "./resourceUsageParts.js";
import {
  clampPercent,
  formatBytes,
  formatPercent,
  isResourceUsageSnapshotComplete,
  type ResourceUsageGroupView,
} from "./resourceUsageView.js";

const CATEGORY_LABEL_IDS: Record<ResourceUsageCategory, string> = {
  base: "resourceManager.category.base",
  "builtin-plugin": "resourceManager.category.builtinPlugin",
  "community-plugin": "resourceManager.category.communityPlugin",
};

export function UsageMetricSummary({
  metric,
  snapshot,
  testId,
}: {
  metric: "cpu" | "memory";
  snapshot: ResourceUsageSnapshot | null;
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  const cpu = metric === "cpu";
  // 整机指标仍可展示；YCode 合计依赖完整进程采样，不完整时显示占位且不画进度。
  const appSnapshot = isResourceUsageSnapshotComplete(snapshot) ? snapshot : null;
  const totalMemoryBytes = snapshot?.system.memoryTotalBytes ?? 0;
  const appMemoryPercent =
    appSnapshot && totalMemoryBytes > 0
      ? clampPercent((appSnapshot.app.memoryBytes / totalMemoryBytes) * 100)
      : 0;
  const systemMemoryPercent =
    snapshot && totalMemoryBytes > 0
      ? clampPercent((snapshot.system.memoryUsedBytes / totalMemoryBytes) * 100)
      : 0;
  const appPercent = cpu ? clampPercent(appSnapshot?.app.cpuPercent ?? 0) : appMemoryPercent;
  const systemPercent = cpu ? clampPercent(snapshot?.system.cpuPercent ?? 0) : systemMemoryPercent;

  return (
    <UsageMeter
      testId={testId}
      label={intl.formatMessage({ id: cpu ? "resourceManager.cpu" : "resourceManager.memory" })}
      appValue={
        appSnapshot
          ? cpu
            ? formatPercent(appSnapshot.app.cpuPercent)
            : formatBytes(appSnapshot.app.memoryBytes)
          : UNSAMPLED_PLACEHOLDER
      }
      systemValue={
        snapshot
          ? cpu
            ? formatPercent(snapshot.system.cpuPercent)
            : formatBytes(snapshot.system.memoryUsedBytes) + " / " + formatBytes(totalMemoryBytes)
          : UNSAMPLED_PLACEHOLDER
      }
      appPercent={appPercent}
      systemPercent={systemPercent}
      appLabel={intl.formatMessage({ id: "resourceManager.appUsage" })}
      systemLabel={intl.formatMessage({ id: "resourceManager.systemUsage" })}
    />
  );
}

export function ResourceManagerUsageTab({
  metric,
  snapshot,
  error,
  groups,
  expanded,
  onToggleGroup,
  overviewFooter,
}: {
  metric: "cpu" | "memory";
  snapshot: ResourceUsageSnapshot | null;
  error: string | null;
  groups: ResourceUsageGroupView[];
  expanded: Record<ResourceUsageCategory, boolean>;
  onToggleGroup: (category: ResourceUsageCategory) => void;
  overviewFooter: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const samplingIncomplete = snapshot !== null && !isResourceUsageSnapshotComplete(snapshot);

  return (
    <div
      className="grid min-h-0 min-w-0 flex-1 grid-cols-1 content-start overflow-y-auto bg-background-alt md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-[auto_minmax(0,1fr)_auto] md:overflow-hidden"
      data-testid="resource-manager-usage-layout"
    >
      {error ? (
        <div
          className="mx-4 mt-4 rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive md:col-span-2 md:row-start-1"
          data-testid="resource-manager-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <aside className="hidden min-w-0 flex-col gap-4 md:col-start-1 md:row-start-2 md:flex md:overflow-y-auto md:p-4">
        <UsageMetricSummary
          metric={metric}
          snapshot={snapshot}
          testId={"resource-manager-" + metric}
        />
      </aside>
      <div className="min-w-0 pt-4 md:col-span-2 md:row-start-3 md:pt-0">{overviewFooter}</div>
      <section
        className="flex min-w-0 flex-col gap-3 px-4 pb-4 md:col-start-2 md:row-start-2 md:min-h-0 md:overflow-y-auto md:p-4"
        data-testid="resource-manager-process-list"
      >
        {samplingIncomplete ? (
          <div
            className="rounded-lg border border-warning/30 bg-card px-3 py-2 text-ui-sm text-warning"
            data-testid="resource-manager-sampling-incomplete"
            role="status"
          >
            {intl.formatMessage({ id: "resourceManager.samplingIncomplete" })}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-ui-sm font-medium">
            {intl.formatMessage({ id: "resourceManager.processes" })}
          </h2>
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({
              id: metric === "cpu" ? "resourceManager.cpu" : "resourceManager.memory",
            })}
          </span>
        </div>
        {groups.map((group) => (
          <UsageGroup
            key={group.category}
            group={group}
            metric={metric}
            title={intl.formatMessage({ id: CATEGORY_LABEL_IDS[group.category] })}
            expanded={expanded[group.category]}
            onToggle={() => onToggleGroup(group.category)}
            emptyText={intl.formatMessage({ id: "resourceManager.empty" })}
            samplingText={intl.formatMessage({ id: "resourceManager.sampling" })}
            columns={{
              process: intl.formatMessage({ id: "resourceManager.column.process" }),
              pid: intl.formatMessage({ id: "resourceManager.column.pid" }),
              cpu: intl.formatMessage({ id: "resourceManager.cpu" }),
              memory: intl.formatMessage({ id: "resourceManager.memory" }),
            }}
          />
        ))}
      </section>
    </div>
  );
}
