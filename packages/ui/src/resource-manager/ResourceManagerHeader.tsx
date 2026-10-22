import { testId, TID_RESOURCE_MANAGER_TAB, type ResourceUsageSnapshot } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/index.js";

export type ResourceManagerTab = "cpu" | "memory" | "disk-io";

const RESOURCE_MANAGER_TABS: ResourceManagerTab[] = ["cpu", "memory", "disk-io"];
const TAB_LABEL_IDS: Record<ResourceManagerTab, string> = {
  cpu: "resourceManager.cpu",
  memory: "resourceManager.memory",
  "disk-io": "resourceManager.diskIo",
};
const REFRESH_INTERVAL_OPTIONS = [1_000, 2_000, 5_000, 10_000] as const;
const REFRESH_INTERVAL_LABEL_IDS: Record<(typeof REFRESH_INTERVAL_OPTIONS)[number], string> = {
  1_000: "resourceManager.interval1s",
  2_000: "resourceManager.interval2s",
  5_000: "resourceManager.interval5s",
  10_000: "resourceManager.interval10s",
};

export function ResourceManagerHeader({
  selectedTab,
  hasDiskIo,
  onTabChange,
  snapshot,
  refreshIntervalMs,
  onRefreshIntervalChange,
}: {
  selectedTab: ResourceManagerTab;
  hasDiskIo: boolean;
  onTabChange: (tab: ResourceManagerTab) => void;
  snapshot: ResourceUsageSnapshot | null;
  refreshIntervalMs: number;
  onRefreshIntervalChange: (intervalMs: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const availableTabs = RESOURCE_MANAGER_TABS.filter((item) => item !== "disk-io" || hasDiskIo);

  return (
    <header className="flex shrink-0 flex-col border-b border-border bg-header px-3 py-2 md:h-12 md:flex-row md:items-center md:justify-between md:gap-4 md:px-4 md:py-0">
      <div className="flex min-w-0 items-center justify-between gap-3 md:flex-1">
        <div className="min-w-0">
          <h1 className="truncate text-ui-base font-medium">
            {intl.formatMessage({ id: "resourceManager.title" })}
          </h1>
          <div className="truncate text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "resourceManager.hostMetrics" })}
            {" · "}
            {snapshot
              ? intl.formatMessage(
                  { id: "resourceManager.processCount" },
                  { count: snapshot.processes.length },
                )
              : intl.formatMessage({ id: "resourceManager.loading" })}
          </div>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-ui-xs text-foreground-subtle">
          <span className="sr-only md:not-sr-only">
            {intl.formatMessage({ id: "resourceManager.updateInterval" })}
          </span>
          <Select
            value={String(refreshIntervalMs)}
            onValueChange={(value) => onRefreshIntervalChange(Number(value))}
          >
            <SelectTrigger
              aria-label={intl.formatMessage({
                id: "resourceManager.updateInterval",
              })}
              data-testid="resource-manager-update-interval"
              className="h-11 min-w-16 bg-background text-ui-sm md:h-8"
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
      </div>
      <Tabs
        value={selectedTab}
        onValueChange={(value) => onTabChange(value as ResourceManagerTab)}
        className="w-full md:w-auto"
      >
        <TabsList
          variant="line"
          className="h-11 w-full justify-start gap-1 p-0 md:h-8 md:w-fit md:justify-center"
        >
          {availableTabs.map((item) => (
            <TabsTrigger
              key={item}
              value={item}
              data-testid={testId(TID_RESOURCE_MANAGER_TAB, item)}
              className="h-11 min-w-0 flex-1 rounded-full px-3 text-ui-sm hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden md:h-8 md:flex-none md:text-ui-base"
            >
              {intl.formatMessage({ id: TAB_LABEL_IDS[item] })}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </header>
  );
}
