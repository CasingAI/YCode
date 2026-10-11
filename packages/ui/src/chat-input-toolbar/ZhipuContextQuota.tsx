import { Loader2 } from "lucide-react";
import type { UsageQuotaLimit } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ChatCodingPlanUsageMeter } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  getQuotaRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";
import { isZhipuTemplateId } from "@/settings/model-provider-section/ZhipuTemplateQuotaSection.js";

export interface ChatZhipuQuotaConfig {
  providerId: string;
  /** 头部「设置」入口：跳设置页智谱模板卡片填写 Coding Plan Key。 */
  onManage: () => void;
}

export function hasChatZhipuQuota(config: ChatZhipuQuotaConfig | undefined): boolean {
  return Boolean(config?.providerId);
}

export function isZhipuQuotaTemplateId(templateId: string | null | undefined): boolean {
  return isZhipuTemplateId(templateId);
}

const METER_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
] as const;

function resolveLimitLabel(limit: UsageQuotaLimit, index: number): string {
  const level = limit.type?.trim();
  if (level) return level;
  return `Quota ${index + 1}`;
}

/**
 * Composer context 浮层里的智谱模板额度段（quota/limit 多条 meter）。
 * 展示件复用 ChatCodingPlanUsageMeter；数据走 useUsageEntitlement（preferredProviderId 直查），
 * 本组件只在浮层展开时挂载，首次请求发生在 hover。
 * 失败（无 monitor 权限、Key 无效、网络失败）显示降级提示，不阻断聊天。
 */
export function ChatZhipuQuotaPanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatZhipuQuotaConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const entitlement = useUsageEntitlement({
    enabled: Boolean(config.providerId),
    includeSubscription: false,
    preferredProviderId: config.providerId,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: `zhipu-template:${config.providerId}`,
    refreshOnMount: true,
    mountRefreshReason: "access",
  });
  const limits = entitlement.snapshot?.quota?.limits ?? [];
  const hasError = entitlement.error !== null || entitlement.snapshot === null;

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </span>
        <CodingPlanUsageHeaderAction
          error={hasError ? "unavailable" : null}
          loading={entitlement.loading}
          openLabel={intl.formatMessage({ id: "chat.minimaxQuota.manage" })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          onUsageClick={config.onManage}
        />
      </div>
      {hasError && !entitlement.loading ? (
        <div className="mb-2">
          <CodingPlanUsageNotice
            message={intl.formatMessage({ id: "settings.modelProvider.zhipuQuota.unavailable" })}
            refreshLabel={intl.formatMessage({ id: "sidebar.usage.plan.refresh" })}
            onRefresh={() => entitlement.refresh({ force: true, reason: "manual" })}
          />
        </div>
      ) : null}
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(limits.length))}>
        {entitlement.loading && limits.length === 0 ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : (
          limits.map((limit, index) => (
            <ChatCodingPlanUsageMeter
              key={`${limit.type}:${limit.unit ?? ""}:${limit.number ?? ""}:${index}`}
              color={METER_COLORS[index % METER_COLORS.length] ?? METER_COLORS[0]!}
              label={resolveLimitLabel(limit, index)}
              percentage={getQuotaRemainingPercentage(limit)}
              resetTime={formatQuotaResetTime({
                locale,
                value: limit.nextResetTime,
                format: "adaptive",
              })}
              value={formatQuotaRemainingPercentage(locale, limit)}
            />
          ))
        )}
      </div>
    </div>
  );
}
