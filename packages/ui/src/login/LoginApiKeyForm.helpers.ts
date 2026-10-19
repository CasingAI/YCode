import {
  isApiKeyAccess,
  resolveProviderTemplateName,
  type ProviderSettingsTemplateView,
} from "@zcode/provider";
import { type AppSettings, type Locale, type ProviderFamilyDomain } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { supportsTemplateQuotaDisplay } from "@/settings/model-provider-section/providerTemplateQuotaTag.js";
import { isZhipuTemplateId } from "@/settings/model-provider-section/ZhipuTemplateQuotaSection.js";

/**
 * 引导页 API Key 表单选中的供应商，以模板 id 为准。
 * 历史上这里写死 `"zai" | "bigmodel"` 两项，见
 * docs/specs/onboarding-quota-providers.md——现在是全部可显示额度的模板。
 */
export type ApiKeyProviderChoice = string;

/** 引导下拉的展示顺序：智谱四模板优先，其次 DeepSeek、MiniMax Token Plan、OpenRouter，末尾 OpenCode（Go 在前、Zen 在后）。 */
const LOGIN_QUOTA_TEMPLATE_ORDER = [
  "zai-api",
  "bigmodel-api",
  "zai-standard-api",
  "bigmodel-standard-api",
  "deepseek",
  "minimax-token-plan",
  "openrouter",
  "opencode-go-chat",
  "opencode-go-messages",
  "opencode-go-responses",
  "opencode-zen-chat",
  "opencode-zen-messages",
  "opencode-zen-responses",
] as const;

/**
 * 引导页可选的额度模板：单 API Key 即可建出可用供应商的模板。
 * 口径 = 设置页 quota Tag（`supportsTemplateQuotaDisplay`）与 api-key 接入的交集。
 * OpenCode Go/Zen 均只需 API Key 即可推理。Go 用量三窗口直接复用该 Key 查询；
 * 仅 Zen 余额仍需在设置页额外配置 Cookie + Workspace（见 opencode-usage-quota.md）。
 */
export function isLoginQuotaProviderTemplate(
  template: Pick<ProviderSettingsTemplateView, "templateId" | "config">,
): boolean {
  return (
    supportsTemplateQuotaDisplay(template.templateId) && isApiKeyAccess(template.config.access)
  );
}

export function resolveLoginApiKeyProviderOptions(
  templates: readonly ProviderSettingsTemplateView[] | null | undefined,
): ProviderSettingsTemplateView[] {
  const order = new Map<string, number>(
    LOGIN_QUOTA_TEMPLATE_ORDER.map((templateId, index) => [templateId, index]),
  );
  return (templates ?? [])
    .filter(isLoginQuotaProviderTemplate)
    .slice()
    .sort(
      (left, right) =>
        (order.get(left.templateId) ?? order.size) - (order.get(right.templateId) ?? order.size) ||
        left.templateId.localeCompare(right.templateId),
    );
}

export function resolveLoginApiKeyDefaultTemplateId(
  locale: Locale,
  availableTemplateIds: readonly string[],
): string | null {
  if (availableTemplateIds.length === 0) {
    return null;
  }
  // 中文默认 BigModel、英文默认 Z.ai：沿用旧二选一时代的 locale 规则。
  const preferred = locale === "zh-CN" ? "bigmodel-api" : "zai-api";
  if (availableTemplateIds.includes(preferred)) {
    return preferred;
  }
  // 数组非空已在上方守卫，第一项必存在；兜底 null 满足 noUncheckedIndexedAccess。
  return availableTemplateIds[0] ?? null;
}

export function resolveLoginApiKeyProviderLabel(
  template: Pick<ProviderSettingsTemplateView, "templateId" | "templateNameMap"> | null | undefined,
  fallbackTemplateId: string,
  locale: Locale,
): string {
  if (!template) {
    return fallbackTemplateId;
  }
  return resolveProviderTemplateName(template.templateId, template, locale);
}

export function resolveLoginApiKeyProviderFamilyDomain(
  templateId: string,
): ProviderFamilyDomain | null {
  // providerFamilyDomain 只认 zai/bigmodel 两种域名归属；非智谱模板跳过时不写该字段。
  if (!isZhipuTemplateId(templateId)) {
    return null;
  }
  return templateId.startsWith("zai") ? "zai" : "bigmodel";
}

export function buildLoginApiKeySkipSettings(
  templateId: string,
  now: number,
): Partial<
  Pick<
    AppSettings,
    "providerFamilyDomain" | "providerFamilyDomainUpdatedAt" | "providerFamilyDomainMigrated"
  >
> {
  const familyDomain = resolveLoginApiKeyProviderFamilyDomain(templateId);
  // 非智谱模板没有域名归属概念：跳过只关引导，不碰 providerFamilyDomain。
  if (!familyDomain) {
    return {
      providerFamilyDomainUpdatedAt: now,
      providerFamilyDomainMigrated: true,
    };
  }
  return {
    providerFamilyDomain: familyDomain,
    providerFamilyDomainUpdatedAt: now,
    providerFamilyDomainMigrated: true,
  };
}

export function shouldShowLoginApiKeyLink(
  apiKeyValue: string,
  apiKeyUrl: string | undefined,
): boolean {
  return Boolean(apiKeyUrl) && apiKeyValue.trim().length === 0;
}

export function buildLoginApiKeyDefaultModelPreferenceFromSelection(
  view: ModelSelectionView,
  providerId: string,
): string | null {
  const firstModel = view.providers.find((provider) => provider.providerId === providerId)
    ?.models[0]?.modelId;
  return firstModel ? encodeCustomModelValue(providerId, firstModel) : null;
}
