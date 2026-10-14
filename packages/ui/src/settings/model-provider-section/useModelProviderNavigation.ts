/* eslint-disable max-lines -- Model Provider 导航需要集中计算分组与选中项，后续拆分时再收敛。 */
import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { isCliProxyProviderTemplateId, isOpenCodeProviderTemplateId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { createCustomProviderNodeKey } from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";

interface UseModelProviderNavigationOptions {
  modelProviders: ProviderSettingsFormProvider[];
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
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

  const opencodeProviders = useMemo(
    () => customProviders.filter((provider) => isOpenCodeProviderTemplateId(provider.templateId)),
    [customProviders],
  );
  const cliproxyProviders = useMemo(
    () => customProviders.filter((provider) => isCliProxyProviderTemplateId(provider.templateId)),
    [customProviders],
  );
  const nonOpencodeCustomProviders = useMemo(
    () =>
      customProviders.filter(
        (provider) =>
          !isOpenCodeProviderTemplateId(provider.templateId) &&
          !isCliProxyProviderTemplateId(provider.templateId),
      ),
    [customProviders],
  );

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => {
    return [
      {
        id: "opencode",
        title: intl.formatMessage({ id: "settings.modelProvider.opencodeTitle" }),
        items: opencodeProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
      {
        id: "cliproxy",
        title: intl.formatMessage({ id: "settings.modelProvider.cliproxyTitle" }),
        items: cliproxyProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: nonOpencodeCustomProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
    ];
  }, [cliproxyProviders, nonOpencodeCustomProviders, opencodeProviders, intl]);

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
