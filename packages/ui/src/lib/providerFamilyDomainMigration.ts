import type { IServiceAccessor } from "@zcode/services";
import {
  type ProviderFamilyDomain,
  resolveProviderFamilyDomainFromOAuthProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";

// 智谱剥离：按 providerId 判定 family 的映射已随 account:* 下线
//（见 docs/specs/zhipu-special-removal.md）。迁移推断只保留 OAuth active provider 一路。
function inferProviderFamilyDomainFromSelection(
  _providers: readonly { readonly providerId: string }[],
): ProviderFamilyDomain | null {
  return null;
}

export async function ensureProviderFamilyDomainMigration(
  services: Pick<IServiceAccessor, "settingService" | "oauthService" | "modelSelectionService">,
): Promise<void> {
  const settings = await services.settingService.get();
  if (settings.providerFamilyDomain || settings.providerFamilyDomainMigrated) {
    return;
  }

  const inferredDomain = resolveProviderFamilyDomainFromOAuthProvider(
    await services.oauthService.getActiveProvider(),
  );

  await services.settingService.update({
    ...(inferredDomain ? { providerFamilyDomain: inferredDomain } : {}),
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
  });

  logger.info("[providerFamilyDomainMigration] provider family domain 迁移完成", {
    inferredDomain,
  });
}
