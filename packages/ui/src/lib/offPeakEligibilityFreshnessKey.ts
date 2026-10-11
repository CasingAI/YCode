import type { AppSettings } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";

/**
 * 闲时套餐资格的失效键。
 *
 * 智谱剥离：账号套餐指纹已下线（见 docs/specs/zhipu-special-removal.md），
 * 键里只保留 family 与连接选择，不再读已删除的 providerId 映射与账号指纹。
 */
export function buildOffPeakEligibilityFreshnessKey(input: {
  readonly settings: AppSettings | null | undefined;
  readonly providerSettingsView: ProviderSettingsView | null;
}): string | undefined {
  const { settings } = input;
  if (!settings) return undefined;
  const family = settings.providerFamilyDomain;
  const connection = family ? settings.providerFamilyConnectionSelections?.[family] : undefined;
  return JSON.stringify([family ?? null, connection ?? null]);
}
