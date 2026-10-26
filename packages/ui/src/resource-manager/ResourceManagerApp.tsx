import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type DiskIoSnapshot,
  type ResourceUsageCategory,
  type ResourceUsageSnapshot,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/index.js";
import { ResourceManagerHeader, type ResourceManagerTab } from "./ResourceManagerHeader.js";
import { ResourceManagerUsageTab, UsageMetricSummary } from "./ResourceManagerUsageTab.js";
import {
  ResourceManagerCpuFooter,
  ResourceManagerMemoryFooter,
} from "./ResourceManagerOverviewFooter.js";
import { createResourceManagerSample, type ResourceManagerSample } from "./resourceOverviewView.js";
import { DiskIoTab } from "./DiskIoTab.js";
import { groupResourceUsage } from "./resourceUsageView.js";

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

export type { ResourceManagerTab } from "./ResourceManagerHeader.js";
const DEFAULT_REFRESH_INTERVAL_MS = 2_000;
const OVERVIEW_SAMPLE_LIMIT = 60;
const REFRESH_INTERVAL_STORAGE_KEY = "zcode-resource-manager-refresh-interval-ms";

function resolveInitialRefreshIntervalMs(explicitIntervalMs?: number): number {
  if (explicitIntervalMs !== undefined) return explicitIntervalMs;
  if (typeof window === "undefined") return DEFAULT_REFRESH_INTERVAL_MS;
  try {
    const stored = Number(window.localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY));
    if ([1_000, 2_000, 5_000, 10_000].includes(stored)) {
      return stored;
    }
  } catch {
    // 存储不可用时仍使用当前窗口默认值。
  }
  return DEFAULT_REFRESH_INTERVAL_MS;
}
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
  // 磁盘采集由宿主注入；Web 没有该能力时回到 CPU，不留在空白页签。
  const selectedTab = tab === "disk-io" && !getDiskIoSnapshot ? "cpu" : tab;
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
          [...current, createResourceManagerSample(next)].slice(-OVERVIEW_SAMPLE_LIMIT),
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
      <ResourceManagerHeader
        selectedTab={selectedTab}
        hasDiskIo={Boolean(getDiskIoSnapshot)}
        onTabChange={setTab}
        snapshot={snapshot}
        refreshIntervalMs={refreshIntervalMs}
        onRefreshIntervalChange={setRefreshIntervalMs}
      />

      {selectedTab === "disk-io" ? (
        getDiskIoSnapshot ? (
          <DiskIoTab getDiskIoSnapshot={getDiskIoSnapshot} refreshIntervalMs={refreshIntervalMs} />
        ) : null
      ) : (
        <ResourceManagerUsageTab
          metric={selectedTab}
          snapshot={snapshot}
          error={error}
          groups={groups}
          expanded={expanded}
          onToggleGroup={toggleGroup}
          overviewFooter={
            selectedTab === "cpu" ? (
              <ResourceManagerCpuFooter
                snapshot={snapshot}
                samples={samples}
                text={footerText}
                mobileSummary={
                  <UsageMetricSummary
                    metric="cpu"
                    snapshot={snapshot}
                    testId="resource-manager-cpu-mobile"
                  />
                }
              />
            ) : (
              <ResourceManagerMemoryFooter
                snapshot={snapshot}
                samples={samples}
                text={footerText}
                mobileSummary={
                  <UsageMetricSummary
                    metric="memory"
                    snapshot={snapshot}
                    testId="resource-manager-memory-mobile"
                  />
                }
              />
            )
          }
        />
      )}
    </main>
  );
}
