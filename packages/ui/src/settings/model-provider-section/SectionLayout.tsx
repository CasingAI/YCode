import { useState, type ReactNode } from "react";
import { TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON } from "@zcode/shared";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { ModelProviderRefreshSignalProvider } from "@/settings/model-provider-section/RefreshSignal.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

interface ModelProviderSectionLayoutProps {
  description: string;
  refreshLabel: string;
  loadingLabel: string;
  presetLoading: boolean;
  customLoading: boolean;
  onRefresh: () => void;
  addProviderLabel: string;
  onAddProvider: () => void;
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavGroup["items"][number]) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  children: ReactNode;
}

function shouldShowModelProviderRefreshLoading(params: {
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  return params.presetLoading || params.customLoading;
}

export function ModelProviderSectionLayout({
  description,
  refreshLabel,
  loadingLabel,
  presetLoading,
  customLoading,
  onRefresh,
  addProviderLabel,
  onAddProvider,
  navigationGroups,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  children,
}: ModelProviderSectionLayoutProps) {
  const refreshButtonLoading = shouldShowModelProviderRefreshLoading({
    presetLoading,
    customLoading,
  });
  // 页面级刷新同时驱动卡片自己的数据源（如 OpenCode 用量），卡片订阅 tick 变化重取。
  const [refreshTick, setRefreshTick] = useState(0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
        <SettingsResourceHeaderActions
          onRefresh={() => {
            setRefreshTick((tick) => tick + 1);
            onRefresh();
          }}
          onNew={onAddProvider}
          refreshing={refreshButtonLoading}
          refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}
          newLabel={addProviderLabel}
          newTestId={TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}
        />
      </div>

      <div className="overflow-clip rounded-xl border border-border bg-card">
        <div
          className="grid min-h-[36rem] grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]"
          data-model-provider-split-panel="true"
        >
          <div
            className="min-w-0 border-r border-border"
            data-model-provider-navigation-scroll="true"
          >
            <ModelProviderSectionNavigation
              navigationGroups={navigationGroups}
              selectedNodeKey={selectedNodeKey}
              presetLoading={presetLoading}
              customLoading={customLoading}
              onSelectNavItem={onSelectNavItem}
              onReorderProviderIds={onReorderProviderIds}
              reorderableProviderIds={reorderableProviderIds}
            />
          </div>
          <div
            className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
            data-model-provider-detail-scroll="true"
          >
            <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
              <ModelProviderRefreshSignalProvider tick={refreshTick}>
                {children}
              </ModelProviderRefreshSignalProvider>
            </ProviderDetailFeedbackBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}
