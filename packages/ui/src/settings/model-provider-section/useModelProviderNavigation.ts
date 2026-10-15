/* eslint-disable max-lines -- Model Provider 导航需要集中计算分组与选中项，后续拆分时再收敛。 */
import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import type {
  ModelProviderNavGroupId,
  ModelProviderNavItem,
} from "@/settings/model-provider-section/constants.js";
import { createCustomProviderNodeKey } from "@/settings/model-provider-section/utils.js";
import {
  resolveProviderNavGroupId,
  resolveNavGroupDisplayOrder,
} from "@/settings/model-provider-section/navGroupOrdering.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";

interface UseModelProviderNavigationOptions {
  modelProviders: ProviderSettingsFormProvider[];
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
  /** 显式分组顺序（空 = 未拖动过分组，按 canonical 兜底）。 */
  navGroupOrder?: readonly string[];
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

// 智谱剥离：account:*/codingPlan/teamPlan/startPlan 独立分支、预置品牌入口、
// family 连接选择与权益态计算已下线（见 docs/specs/zhipu-special-removal.md）。
// 导航只保留 custom/personal（含 opencode 独立分组），模板新建的智谱 provider
// 与普通 custom 走同一条展示路径。
export function useModelProviderNavigation({
  modelProviders,
  displayOrder,
  navGroupOrder,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: UseModelProviderNavigationOptions) {
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      (provider) => provider.config.group === "standard-personal",
    );
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => {
    const itemsByGroupId: Record<ModelProviderNavGroupId, ModelProviderNavItem[]> = {
      opencode: [],
      cliproxy: [],
      custom: [],
    };
    for (const provider of customProviders) {
      itemsByGroupId[resolveProviderNavGroupId(provider)].push({
        key: createCustomProviderNodeKey(provider.providerId),
        type: "custom" as const,
        label: getProviderFormLabel(provider),
        provider,
        statusActive: provider.executable === true,
      });
    }
    const titles: Record<ModelProviderNavGroupId, string> = {
      opencode: intl.formatMessage({ id: "settings.modelProvider.opencodeTitle" }),
      cliproxy: intl.formatMessage({ id: "settings.modelProvider.cliproxyTitle" }),
      custom: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
    };
    // 分组顺序读取显式持久化偏好（拖组时写入），从未设置时按 canonical 兜底，
    // 保证老用户默认看到与历史一致的分组位置。见 navGroupOrdering.ts。
    return resolveNavGroupDisplayOrder({ explicitGroupOrder: navGroupOrder }).map((groupId) => ({
      id: groupId,
      title: titles[groupId],
      items: itemsByGroupId[groupId],
    }));
  }, [customProviders, navGroupOrder, intl]);

  const navigationItems = useMemo(
    () => navigationGroups.flatMap((group) => group.items),
    [navigationGroups],
  );

  const navigationItemByKey = useMemo(
    () => new Map(navigationItems.map((item) => [item.key, item])),
    [navigationItems],
  );

  const selectedNavItem = selectedNodeKey ? (navigationItemByKey.get(selectedNodeKey) ?? null) : null;

  const fallbackNodeKey = navigationItems[0]?.key ?? null;
  useEffect(() => {
    if (selectedNodeKey && navigationItemByKey.has(selectedNodeKey)) {
      return;
    }
    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [fallbackNodeKey, selectedNodeKey, setSelectedNodeKey, navigationItemByKey]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable: false,
  };
}

export function connectionSelectionMatchesNavigationItem(): boolean {
  // 智谱剥离：family 连接选择匹配已下线，保留导出签名兼容旧引用，统一返回 false。
  return false;
}
