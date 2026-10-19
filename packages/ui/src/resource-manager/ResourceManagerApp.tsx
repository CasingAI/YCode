import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TID_RESOURCE_MANAGER_TAB,
  testId,
  type DiskIoSnapshot,
  type ResourceUsageCategory,
  type ResourceUsageSnapshot,
} from "@zcode/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { UNSAMPLED_PLACEHOLDER, UsageGroup, UsageMeter } from "./resourceUsageParts.js";
import {
  ResourceManagerCpuFooter,
  ResourceManagerMemoryFooter,
} from "./ResourceManagerOverviewFooter.js";
import { toMemoryPercent, type ResourceManagerSample } from "./resourceOverviewView.js";
import { DiskIoTab } from "./DiskIoTab.js";
import {
  clampPercent,
  formatBytes,
  formatPercent,
  groupResourceUsage,
  type ResourceUsageGroupView,
} from "./resourceUsageView.js";

export interface ResourceManagerAppProps {
  /** 缺省表示桥接不可用（例如非桌面环境） */
  getSnapshot?: () => Promise<ResourceUsageSnapshot>;
  /** Main 内存中的 I/O 快照；读取不会启动或停止后台采集。 */
  getDiskIoSnapshot?: () => Promise<DiskIoSnapshot>;
  setSamplingActive?: (active: boolean) => void;
  setRefreshInterval?: (intervalMs: number) => void;
  /** 显式初始周期（测试或嵌入场景）；桌面窗口默认读取自己的持久化选择。 */
  refreshIntervalMs?: number;
  /** 初始 tab，默认 CPU */
  initialTab?: ResourceManagerTab;
}

export type ResourceManagerTab = "cpu" | "memory" | "disk-io";
const RESOURCE_MANAGER_TABS: ResourceManagerTab[] = ["cpu", "memory", "disk-io"];
const TAB_LABEL_IDS: Record<ResourceManagerTab, string> = {
  cpu: "resourceManager.cpu",
  memory: "resourceManager.memory",
  "disk-io": "resourceManager.diskIo",
};

const DEFAULT_REFRESH_INTERVAL_MS = 2_000;
const OVERVIEW_SAMPLE_LIMIT = 60;
const REFRESH_INTERVAL_STORAGE_KEY = "zcode-resource-manager-refresh-interval-ms";
const REFRESH_INTERVAL_OPTIONS = [1_000, 2_000, 5_000, 10_000] as const;
const REFRESH_INTERVAL_LABEL_IDS: Record<(typeof REFRESH_INTERVAL_OPTIONS)[number], string> = {
  1_000: "resourceManager.interval1s",
  2_000: "resourceManager.interval2s",
  5_000: "resourceManager.interval5s",
  10_000: "resourceManager.interval10s",
};

function resolveInitialRefreshIntervalMs(explicitIntervalMs?: number): number {
  if (explicitIntervalMs !== undefined) return explicitIntervalMs;
  if (typeof window === "undefined") return DEFAULT_REFRESH_INTERVAL_MS;
  try {
    const stored = Number(window.localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY));
    if (REFRESH_INTERVAL_OPTIONS.includes(stored as (typeof REFRESH_INTERVAL_OPTIONS)[number])) {
      return stored;
    }
  } catch {
    // 存储不可用时仍使用当前窗口默认值。
  }
  return DEFAULT_REFRESH_INTERVAL_MS;
}
const CATEGORY_LABEL_IDS: Record<ResourceUsageCategory, string> = {
  base: "resourceManager.category.base",
  "builtin-plugin": "resourceManager.category.builtinPlugin",
  "community-plugin": "resourceManager.category.communityPlugin",
};

/**
 * 资源管理器窗口 UI。
 * 组件放在 packages/ui 内是为了纳入 Tailwind 扫描；desktop 的独立 renderer 入口只负责挂载。
 */
export function ResourceManagerApp({
  getSnapshot,
  getDiskIoSnapshot,
  setSamplingActive,
  setRefreshInterval,
  refreshIntervalMs: initialRefreshIntervalMs,
  initialTab = "cpu",
}: ResourceManagerAppProps) {
  const { intl } = useZCodeIntl();
  const footerText = useCallback(
    (key: string) => intl.formatMessage({ id: `resourceManager.${key}` }),
    [intl],
  );
  useEffect(() => {
    document.title = intl.formatMessage({ id: "resourceManager.title" });
  }, [intl]);
  const [tab, setTab] = useState<ResourceManagerTab>(initialTab);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(() =>
    resolveInitialRefreshIntervalMs(initialRefreshIntervalMs),
  );
  const [snapshot, setSnapshot] = useState<ResourceUsageSnapshot | null>(null);
  const [samples, setSamples] = useState<ResourceManagerSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<ResourceUsageCategory, boolean>>({
    base: true,
    "builtin-plugin": true,
    "community-plugin": true,
  });

  useEffect(() => {
    if (!getSnapshot) {
      setError(intl.formatMessage({ id: "resourceManager.unavailable" }));
      return;
    }
    setSamplingActive?.(true);
    return () => {
      // 停止 renderer 定时器还不够，Host 在途采样也必须随页面生命周期取消。
      setSamplingActive?.(false);
    };
  }, [getSnapshot, intl, setSamplingActive]);

  useEffect(() => {
    try {
      window.localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(refreshIntervalMs));
    } catch {
      // 本地偏好保存失败不应中断实时采样。
    }
    setRefreshInterval?.(refreshIntervalMs);
  }, [refreshIntervalMs, setRefreshInterval]);

  useEffect(() => {
    const fetchSnapshot = getSnapshot;
    if (!fetchSnapshot) return;
    let disposed = false;
    let inFlight = false;

    async function refresh() {
      // 请求串行：上一轮未返回（Host 采样慢）时不叠加新请求。
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchSnapshot!();
        if (disposed) return;
        setSnapshot(next);
        setSamples((current) =>
          [
            ...current,
            {
              systemCpuPercent: next.system.cpuPercent,
              appCpuPercent: next.app.cpuPercent,
              systemMemoryPercent: toMemoryPercent(
                next.system.memoryUsedBytes,
                next.system.memoryTotalBytes,
              ),
              appMemoryPercent: toMemoryPercent(next.app.memoryBytes, next.system.memoryTotalBytes),
            },
          ].slice(-OVERVIEW_SAMPLE_LIMIT),
        );
        setError(null);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
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
  }, [getSnapshot, refreshIntervalMs]);

  const groups = useMemo(() => groupResourceUsage(snapshot?.processes ?? []), [snapshot]);
  const toggleGroup = useCallback((category: ResourceUsageCategory) => {
    setExpanded((current) => ({ ...current, [category]: !current[category] }));
  }, []);

  return (
    <main
      className="flex h-dvh min-h-0 flex-col bg-background text-foreground"
      data-testid="resource-manager"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-header px-4">
        <div className="min-w-0">
          <h1 className="truncate text-ui-base font-medium">
            {intl.formatMessage({ id: "resourceManager.title" })}
          </h1>
          <div className="text-ui-xs text-foreground-subtle">
            {snapshot
              ? intl.formatMessage(
                  { id: "resourceManager.processCount" },
                  { count: snapshot.processes.length },
                )
              : intl.formatMessage({ id: "resourceManager.loading" })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
            <span>{intl.formatMessage({ id: "resourceManager.updateInterval" })}</span>
            <Select
              value={String(refreshIntervalMs)}
              onValueChange={(value) => setRefreshIntervalMs(Number(value))}
            >
              <SelectTrigger
                aria-label={intl.formatMessage({
                  id: "resourceManager.updateInterval",
                })}
                data-testid="resource-manager-update-interval"
                className="h-8 bg-background text-ui-sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REFRESH_INTERVAL_OPTIONS.map((intervalMs) => (
                  <SelectItem key={intervalMs} value={String(intervalMs)}>
                    {intl.formatMessage({
                      id: REFRESH_INTERVAL_LABEL_IDS[intervalMs],
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Tabs value={tab} onValueChange={(value) => setTab(value as ResourceManagerTab)}>
            <TabsList variant="line" className="h-8 gap-1 p-0">
              {RESOURCE_MANAGER_TABS.map((item) => (
                <TabsTrigger
                  key={item}
                  value={item}
                  data-testid={testId(TID_RESOURCE_MANAGER_TAB, item)}
                  className="h-8 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                >
                  {intl.formatMessage({ id: TAB_LABEL_IDS[item] })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>

      {tab === "disk-io" ? (
        <DiskIoTab getDiskIoSnapshot={getDiskIoSnapshot} refreshIntervalMs={refreshIntervalMs} />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto bg-background-alt p-4">
            <UsageTabContent
              metric={tab}
              snapshot={snapshot}
              error={error}
              groups={groups}
              expanded={expanded}
              onToggleGroup={toggleGroup}
            />
          </div>
          {tab === "cpu" ? (
            <ResourceManagerCpuFooter snapshot={snapshot} samples={samples} text={footerText} />
          ) : null}
          {tab === "memory" ? (
            <ResourceManagerMemoryFooter snapshot={snapshot} samples={samples} text={footerText} />
          ) : null}
        </>
      )}
    </main>
  );
}

/** CPU / 内存 tab 的正文：左侧对应指标卡，右侧分组列表只显示当前指标列。 */
function UsageTabContent({
  metric,
  snapshot,
  error,
  groups,
  expanded,
  onToggleGroup,
}: {
  metric: "cpu" | "memory";
  snapshot: ResourceUsageSnapshot | null;
  error: string | null;
  groups: ResourceUsageGroupView[];
  expanded: Record<ResourceUsageCategory, boolean>;
  onToggleGroup: (category: ResourceUsageCategory) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      {error ? (
        <div
          className="rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive"
          data-testid="resource-manager-error"
        >
          {error}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-4">
          {metric === "cpu" ? (
            <UsageMeter
              testId="resource-manager-cpu"
              label={intl.formatMessage({ id: "resourceManager.cpu" })}
              appValue={snapshot ? formatPercent(snapshot.app.cpuPercent) : UNSAMPLED_PLACEHOLDER}
              systemValue={
                snapshot ? formatPercent(snapshot.system.cpuPercent) : UNSAMPLED_PLACEHOLDER
              }
              appPercent={snapshot ? clampPercent(snapshot.app.cpuPercent) : 0}
              systemPercent={snapshot ? clampPercent(snapshot.system.cpuPercent) : 0}
              appLabel={intl.formatMessage({ id: "resourceManager.appUsage" })}
              systemLabel={intl.formatMessage({
                id: "resourceManager.systemUsage",
              })}
            />
          ) : (
            <UsageMeter
              testId="resource-manager-memory"
              label={intl.formatMessage({ id: "resourceManager.memory" })}
              appValue={snapshot ? formatBytes(snapshot.app.memoryBytes) : UNSAMPLED_PLACEHOLDER}
              systemValue={
                snapshot
                  ? `${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`
                  : UNSAMPLED_PLACEHOLDER
              }
              appPercent={
                snapshot && snapshot.system.memoryTotalBytes > 0
                  ? clampPercent(
                      (snapshot.app.memoryBytes / snapshot.system.memoryTotalBytes) * 100,
                    )
                  : 0
              }
              systemPercent={
                snapshot && snapshot.system.memoryTotalBytes > 0
                  ? clampPercent(
                      (snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes) * 100,
                    )
                  : 0
              }
              appLabel={intl.formatMessage({ id: "resourceManager.appUsage" })}
              systemLabel={intl.formatMessage({
                id: "resourceManager.systemUsage",
              })}
            />
          )}
        </aside>

        <section className="flex min-w-0 flex-col gap-3">
          {groups.map((group) => (
            <UsageGroup
              key={group.category}
              group={group}
              metric={metric}
              title={intl.formatMessage({
                id: CATEGORY_LABEL_IDS[group.category],
              })}
              expanded={expanded[group.category]}
              onToggle={() => onToggleGroup(group.category)}
              emptyText={intl.formatMessage({ id: "resourceManager.empty" })}
              samplingText={intl.formatMessage({
                id: "resourceManager.sampling",
              })}
              columns={{
                process: intl.formatMessage({
                  id: "resourceManager.column.process",
                }),
                pid: intl.formatMessage({ id: "resourceManager.column.pid" }),
                cpu: intl.formatMessage({ id: "resourceManager.cpu" }),
                memory: intl.formatMessage({ id: "resourceManager.memory" }),
              }}
            />
          ))}
        </section>
      </div>
    </>
  );
}
