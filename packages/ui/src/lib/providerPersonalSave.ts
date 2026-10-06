import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

/**
 * 保存设置页明确维护的稀疏 Personal Overlay。
 */
export async function persistPersonalProvider(params: {
  provider: ProviderSettingsFormProvider;
  providerSettingsService: Pick<IProviderSettingsService, "savePersonalProviderOverlay">;
}): Promise<ProviderSettingsView> {
  const {
    builtinModelIds: _builtinModelIds,
    personalModelIds: _modelIds,
    ...providerFields
  } = params.provider.personalConfig;
  return params.providerSettingsService.savePersonalProviderOverlay(
    params.provider.providerId,
    structuredClone(providerFields),
    params.provider.providerNameUpdate === undefined &&
      params.provider.enabledUpdate === undefined &&
      params.provider.isPrimaryUpdate === undefined
      ? undefined
      : {
          ...(params.provider.providerNameUpdate === undefined
            ? {}
            : { providerName: params.provider.providerNameUpdate }),
          ...(params.provider.enabledUpdate === undefined
            ? {}
            : { enabled: params.provider.enabledUpdate }),
          // 只提交本次显式切换的 Primary 值；未触碰时不把继承标记物化进个人配置。
          ...(params.provider.isPrimaryUpdate === undefined
            ? {}
            : { isPrimary: params.provider.isPrimaryUpdate }),
        },
  );
}
