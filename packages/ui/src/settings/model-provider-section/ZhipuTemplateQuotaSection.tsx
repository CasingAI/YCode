import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { UsageQuotaLimit } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { PlanUsageMetricCard } from "./StatusCards.js";

// 智谱模板 ID 白名单：与 services 层 bigmodelUsageQuotaProvider 的 ZHIPU_TEMPLATE_IDS 同源
//（见 docs/specs/zhipu-special-removal.md）。模板自建 provider 用自存 Coding Plan Key
// 直查 quota/limit，无需 OAuth 与 accountAccess。
export const ZHIPU_TEMPLATE_IDS = new Set([
  "zai-api",
  "bigmodel-api",
  "zai-standard-api",
  "bigmodel-standard-api",
]);

export function isZhipuTemplateId(templateId: string | null | undefined): boolean {
  return Boolean(templateId && ZHIPU_TEMPLATE_IDS.has(templateId.trim()));
}

const QUOTA_PROGRESS_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
] as const;

function toUsageLimit(limit: UsageQuotaLimit): UsageQuotaLimit {
  return {
    ...limit,
    usageDetails: limit.usageDetails ?? [],
  };
}

/**
 * 智谱模板自建 provider 卡片上的「剩余额度」区块（statusSection 插槽）。
 *
 * 卡片视觉复用 PlanUsageMetricCard（与 MiniMaxQuotaSection 同构）；
 * 数据走 useUsageEntitlement + 新版 getEntitlementSnapshot（preferredProviderId 直查），
 * 查询失败（无 monitor 权限、Key 无效、网络失败）显示降级提示，不阻断保存与聊天。
 */
export function ZhipuTemplateQuotaSection({ providerId }: { providerId: string }) {
  const { intl, locale } = useZCodeIntl();
  const entitlement = useUsageEntitlement({
    enabled: Boolean(providerId),
    includeSubscription: false,
    preferredProviderId: providerId,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: `zhipu-template:${providerId}`,
    refreshOnMount: true,
    mountRefreshReason: "initial",
  });

  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(entitlement.refresh);
  refreshRef.current = entitlement.refresh;
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    void refreshRef.current({ force: true, reason: "manual" });
  }, [refreshTick]);

  const limits = entitlement.snapshot?.quota?.limits ?? [];
  const level = entitlement.snapshot?.quota?.level?.trim() ?? "";
  const unavailable = entitlement.snapshot === null || entitlement.error !== null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
          {level ? ` · ${level}` : ""}
        </h4>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {entitlement.loading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
      </div>

      {unavailable && !entitlement.loading ? (
        <p className="mt-2 text-ui-xs text-warning" role="alert">
          {intl.formatMessage({ id: "settings.modelProvider.zhipuQuota.unavailable" })}
        </p>
      ) : null}

      {limits.length > 0 ? (
        <div className="mt-2 flex w-full gap-2 max-sm:flex-col">
          {limits.map((limit, index) => (
            <PlanUsageMetricCard
              key={`${limit.type}:${limit.unit ?? ""}:${limit.number ?? ""}:${index}`}
              limit={toUsageLimit(limit)}
              detail={formatQuotaResetTime({
                locale,
                value: limit.nextResetTime,
                format: "dateTime",
              })}
              progressColor={QUOTA_PROGRESS_COLORS[index % QUOTA_PROGRESS_COLORS.length] ?? QUOTA_PROGRESS_COLORS[0]!}
              resetTimeFormat="dateTime"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
