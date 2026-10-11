import type { ModelConnectivityResult } from "@zcode/shared";
import { getProviderFormApiKeyManagementUrl } from "@/lib/providerSettingsFormTypes.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { type ModelProviderNavItem } from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import {
  isDeepSeekProviderTemplateId,
  isMiniMaxTokenPlanProviderTemplateId,
  isOpenCodeGoProviderTemplateId,
  isOpenCodeZenProviderTemplateId,
  isOpenRouterProviderTemplateId,
} from "@zcode/shared";
import { DeepSeekBalanceSection } from "./DeepSeekBalanceSection.js";
import { MiniMaxQuotaSection } from "./MiniMaxQuotaSection.js";
import { OpenCodeUsageSection } from "./OpenCodeUsageSection.js";
import { OpenCodeZenBalanceSection } from "./OpenCodeZenBalanceSection.js";
import { OpenRouterBalanceSection } from "./OpenRouterBalanceSection.js";
import { ModelProviderLoadingCard } from "./StatusCards.js";
import {
  isZhipuTemplateId,
  ZhipuTemplateQuotaSection,
} from "./ZhipuTemplateQuotaSection.js";
import type { ProviderSettingsView } from "@zcode/services";
import type { SavePersonalModelDraftInput } from "@zcode/provider";

// 智谱剥离：account:*/codingPlan/teamPlan/startPlan 独立分支、family 头部、
// 套餐权益卡、Team/Start 逻辑已删除（见 docs/specs/zhipu-special-removal.md）。
// 详情只保留 custom/personal（含智谱模板额度分支）；模板新建的智谱 provider
// 与普通 custom 走同一条展示与删除路径（可删除）。
export function ModelProviderSectionDetail({
  selectedNavItem,
  presetLoading,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onReorderProviderModels,
  onTestModel,
  onOpenApiKeyUrl,
  providerSettingsView: providerSettingsViewOverride,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems?: ModelProviderNavItem[];
  connectionSettingsFailed?: boolean;
  connectionSelections?: unknown;
  startPlanSubscriptionCount?: number;
  presetLoading: boolean;
  codingPlanAuthError?: string | null;
  presetSubscriptionProviderId?: string | null;
  codingPlanStatusSyncProviderId?: string | null;
  codingPlanDisconnectProviderId?: string | null;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onReorderProviderModels?: (providerId: string, modelIds: string[]) => Promise<void>;
  onTestModel: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onRetryCodingPlan?: () => void | Promise<void>;
  onCodingPlanLogin?: (...args: never[]) => unknown;
  onCodingPlanDisconnect?: (...args: never[]) => unknown;
  onOpenApiKeyUrl: (url: string) => void;
  onOpenBigModelRegistration?: () => void;
  onCodingPlanEntitlementRefresh?: () => void | Promise<void>;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
  providerSettingsView?: ProviderSettingsView | null;
}) {
  const { intl } = useZCodeIntl();
  const loadingLabel = intl.formatMessage({ id: "common.loading" });
  void providerSettingsViewOverride;
  const modelEditingProps = {
    onAddPersonalModel,
    onSavePersonalModelDraft,
    onSetPersonalModelEnabled,
    onDeletePersonalModel,
    settingsRevision: undefined,
  };

  if (!selectedNavItem) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  if (!selectedNavItem.provider) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  const customProvider = selectedNavItem.provider;
  const customApiKeyUrl = customProvider.templateId
    ? getProviderFormApiKeyManagementUrl(customProvider)
    : undefined;
  return (
    <InlineEditableProviderCard
      provider={customProvider}
      onSave={onSave}
      {...modelEditingProps}
      onDelete={() => onDelete(customProvider)}
      onReorderModelIds={
        onReorderProviderModels
          ? (modelIds) => onReorderProviderModels(customProvider.providerId, modelIds)
          : undefined
      }
      onTestModel={onTestModel}
      presetApiKeyUrl={customApiKeyUrl}
      readOnlyEndpoints={false}
      nameEditable
      statusSection={
        isOpenCodeGoProviderTemplateId(customProvider.templateId) ? (
          <OpenCodeUsageSection providerId={customProvider.providerId} />
        ) : isOpenCodeZenProviderTemplateId(customProvider.templateId) ? (
          <OpenCodeZenBalanceSection providerId={customProvider.providerId} />
        ) : isDeepSeekProviderTemplateId(customProvider.templateId) ? (
          <DeepSeekBalanceSection providerId={customProvider.providerId} />
        ) : isMiniMaxTokenPlanProviderTemplateId(customProvider.templateId) ? (
          <MiniMaxQuotaSection providerId={customProvider.providerId} />
        ) : isOpenRouterProviderTemplateId(customProvider.templateId) ? (
          <OpenRouterBalanceSection providerId={customProvider.providerId} />
        ) : isZhipuTemplateId(customProvider.templateId) ? (
          // 智谱模板自建 provider：填 Coding Plan Key 后显示剩余额度；
          // 普通推理 Key（无 monitor 权限）降级提示，不阻断聊天。
          <ZhipuTemplateQuotaSection providerId={customProvider.providerId} />
        ) : undefined
      }
      onOpenPresetApiKey={
        customApiKeyUrl
          ? () => {
              onOpenApiKeyUrl(customApiKeyUrl);
            }
          : undefined
      }
    />
  );
}
