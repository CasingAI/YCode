import type { AppSettings } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { getModelProviderFamilySpec } from "@zcode/shared";
import { resolveAccountProviderInspectionFingerprint } from "@/lib/accountProviderAccess.js";

/**
 * 闲时套餐资格的失效键。
 *
 * 资格只取决于"当前 family 选中的付费套餐现在是否有效"，所以键里放连接选择加该套餐的
 * 账号事实指纹。这里刻意不用 ProviderSettings View revision：它每保存一次配置就 +1，
 * 拿它当失效键会让改模型名、拨 Provider 开关这类纯配置变更也重查资格。指纹里的
 * availability / entitled / current / connectionKey 覆盖了"账号稍后就绪需要重查"的场景。
 */
export function buildOffPeakEligibilityFreshnessKey(input: {
  readonly settings: AppSettings | null | undefined;
  readonly providerSettingsView: ProviderSettingsView | null;
}): string | undefined {
  const { settings, providerSettingsView } = input;
  if (!settings || !providerSettingsView) return undefined;
  const family = settings.providerFamilyDomain;
  const connection = family ? settings.providerFamilyConnectionSelections?.[family] : undefined;
  const spec = family ? getModelProviderFamilySpec(family) : null;
  const codingPlanProviderId =
    connection?.kind === "team-coding-plan" && spec
      ? spec.teamCodingPlanProviderId
      : spec?.individualCodingPlanProviderId;
  return JSON.stringify([
    family ?? null,
    connection ?? null,
    codingPlanProviderId
      ? resolveAccountProviderInspectionFingerprint(providerSettingsView, codingPlanProviderId)
      : "",
  ]);
}
