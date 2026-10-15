import type { ModelConnectivityResult } from "@zcode/shared";
import { getProviderFormApiKeyManagementUrl } from "@/lib/providerSettingsFormTypes.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { type ModelProviderNavItem } from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import {
  isCliProxyProviderTemplateId,
  isDeepSeekProviderTemplateId,
  isMiniMaxTokenPlanProviderTemplateId,
  isOpenCodeGoProviderTemplateId,
  isOpenCodeZenProviderTemplateId,
  isOpenRouterProviderTemplateId,
} from "@zcode/shared";
import { CliProxyQuotaSection } from "./CliProxyQuotaSection.js";
import { CliProxyModelSyncButton } from "./CliProxyModelSyncButton.js";
import { DeepSeekBalanceSection } from "./DeepSeekBalanceSection.js";
import { MiniMaxQuotaSection } from "./MiniMaxQuotaSection.js";
import { OpenCodeUsageSection } from "./OpenCodeUsageSection.js";
import { OpenCodeZenBalanceSection } from "./OpenCodeZenBalanceSection.js";
import { OpenRouterBalanceSection } from "./OpenRouterBalanceSection.js";
import { ModelProviderLoadingCard } from "./StatusCards.js";
import { resolveModelProviderDetailViewState } from "./detailViewState.js";
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
  navigationItems,
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
  // 真实 Registry revision 由 View 所有：Detail 只透传，不创造默认值。
  // 缺失时下游必须显式报错，禁止用 0 伪装成有效版本。
  const settingsRevision = providerSettingsViewOverride?.revision;
  const modelEditingProps = {
    onAddPersonalModel,
    onSavePersonalModelDraft,
    onSetPersonalModelEnabled,
    onDeletePersonalModel,
    settingsRevision,
  };

  if (!selectedNavItem) {
    // 零供应商环境没有默认选中项；若数据已就绪则是空状态而非加载中，
    // 不能复用加载卡片造成永久假加载（docs/specs/model-provider-empty-state.md）。
    const viewState = resolveModelProviderDetailViewState({
      hasSelection: false,
      presetLoading,
      navigationItemCount: navigationItems ? navigationItems.length : null,
    });
    if (viewState === "empty") {
      return (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
          <p className="text-ui-base text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.empty" })}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.emptyHint" })}
          </p>
        </div>
      );
    }
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
      modelsHeaderAction={
        isCliProxyProviderTemplateId(customProvider.templateId) && onAddPersonalModel ? (
          <CliProxyModelSyncButton
            providerId={customProvider.providerId}
            onAddModel={onAddPersonalModel}
          />
        ) : undefined
      }
      statusSection={
        isOpenCodeGoProviderTemplateId(customProvider.templateId) ? (
          <OpenCodeUsageSection providerId={customProvider.providerId} />
        ) : isCliProxyProviderTemplateId(customProvider.templateId) ? (
          <CliProxyQuotaSection
            providerId={customProvider.providerId}
            templateId={customProvider.templateId}
          />
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
