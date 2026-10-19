import { type ReactNode } from "react";
import {
  TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
  TID_MODEL_PROVIDER_SPLIT_PANEL,
} from "@zcode/shared";
import { SettingsMasterDetailLayout } from "@/settings/SettingsMasterDetailLayout.js";
import type {
  ModelProviderNavGroup,
  ModelProviderNavGroupId,
} from "@/settings/model-provider-section/constants.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import {
  ModelProviderRefreshSignalProvider,
  useModelProviderRefreshController,
} from "@/settings/model-provider-section/RefreshSignal.js";
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
  onReorderNavGroups?: (groupIds: ModelProviderNavGroupId[]) => Promise<void>;
  children: ReactNode;
}

function shouldShowModelProviderRefreshLoading(params: {
  presetLoading: boolean;
  customLoading: boolean;
  pendingCount: number;
}): boolean {
  // 额度/余额查询在途时按钮同样进入加载态：否则页面看着已经刷新完，卡片却还是空的。
  return params.presetLoading || params.customLoading || params.pendingCount > 0;
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
  onReorderNavGroups,
  children,
}: ModelProviderSectionLayoutProps) {
  // 页面级刷新同时驱动卡片自己的数据源（如 OpenCode 用量、额度/余额卡片），卡片订阅 tick 变化重取。
  const refresh = useModelProviderRefreshController();
  const refreshButtonLoading = shouldShowModelProviderRefreshLoading({
    presetLoading,
    customLoading,
    pendingCount: refresh.pendingCount,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
        <SettingsResourceHeaderActions
          onRefresh={() => {
            refresh.triggerRefresh();
            onRefresh();
          }}
          onNew={onAddProvider}
          refreshing={refreshButtonLoading}
          refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}
          newLabel={addProviderLabel}
          newTestId={TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}
        />
      </div>

      <SettingsMasterDetailLayout
        testId={TID_MODEL_PROVIDER_SPLIT_PANEL}
        navigation={
          <ModelProviderSectionNavigation
            navigationGroups={navigationGroups}
            selectedNodeKey={selectedNodeKey}
            presetLoading={presetLoading}
            customLoading={customLoading}
            onSelectNavItem={onSelectNavItem}
            onReorderProviderIds={onReorderProviderIds}
            reorderableProviderIds={reorderableProviderIds}
            onReorderNavGroups={onReorderNavGroups}
          />
        }
      >
        <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
          <ModelProviderRefreshSignalProvider value={refresh}>
            {children}
          </ModelProviderRefreshSignalProvider>
        </ProviderDetailFeedbackBoundary>
      </SettingsMasterDetailLayout>
    </div>
  );
}
