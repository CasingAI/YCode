import type { IServiceAccessor } from "@zcode/services";
import type { OAuthProviderId } from "@zcode/shared";
import { resolveProviderFamilyDomainFromOAuthProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  type ModelProviderFamilyConnectionSelection,
  resolveAutomaticModelProviderFamilyConnectionSelection,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

// 智谱剥离：账号权益/团队定价查询已下线（见 docs/specs/zhipu-special-removal.md）。
// 登录后只保留已保存连接的读取与默认个人 Coding 落点，不再按权益自动改写。

export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.provider);
  if (!domain) {
    return null;
  }

  const currentSettings = await params.services.settingService.get();
  const savedSelection = currentSettings.providerFamilyConnectionSelections?.[domain];
  if (savedSelection) return savedSelection;
  const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
    providerFamilyDomain: domain,
    codingPlanEntitlement: null,
    startPlanEntitlement: null,
    teamProducts: [],
  });
  if (!selection) {
    return null;
  }

  await params.services.settingService.update(
    {
      providerFamilyConnectionSelections: {
        ...currentSettings.providerFamilyConnectionSelections,
        [domain]: selection,
      },
    },
    {
      providerFamilyDomain: currentSettings.providerFamilyDomain,
      providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
    },
  );
  return selection;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.activeProvider);
  if (!domain) return null;
  const settings = await params.services.settingService.get();
  if (settings.providerFamilyDomain && settings.providerFamilyDomain !== domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] 启动账号刷新失败，保留原连接", { error });
    }
    return saved;
  }
  try {
    const selection = await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: params.activeProvider,
      services: params.services,
    });
    if (selection) await params.refreshAppSettings?.();
    return selection;
  } catch (error) {
    logger.warn("[Root] 启动初始化连接失败", { error });
    return null;
  }
}
