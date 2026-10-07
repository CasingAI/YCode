import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MiniMaxQuotaErrorKind, UsageQuotaLimit } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMiniMaxQuota } from "@/hooks/useMiniMaxQuota.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { formatMiniMaxRemainingPercent, toMiniMaxQuotaLines } from "./minimaxQuotaDisplay.js";
import { PlanUsageMetricCard } from "./StatusCards.js";

const WINDOW_LABEL_IDS = {
  interval: "settings.modelProvider.minimaxQuota.window.interval",
  weekly: "settings.modelProvider.minimaxQuota.window.weekly",
} as const;

const WINDOW_PROGRESS_COLORS = {
  interval: "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
} as const;

const ERROR_MESSAGE_IDS: Record<Exclude<MiniMaxQuotaErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.minimaxQuota.error.credentialStale",
  unavailable: "settings.modelProvider.minimaxQuota.error.unavailable",
};

/**
 * MiniMax 额度窗口 → 官方 PlanUsageMetricCard 的 UsageQuotaLimit 投影。
 * percentage 口径与官方一致：已用占比，卡片内部反转为剩余展示。
 */
function toUsageLimit(usagePercent: number, resetAt: string | null): UsageQuotaLimit {
  return {
    type: "OPENCODE_USAGE",
    percentage: usagePercent,
    nextResetTime: resetAt ? Date.parse(resetAt) : undefined,
    usageDetails: [],
  };
}

/**
 * minimax-token-plan provider 卡片上的「剩余额度」区块（statusSection 插槽）。
 *
 * 卡片视觉复用官方 PlanUsageMetricCard（与 OpenCodeUsageSection 同构）；
 * status === 3 的窗口显示「不在套餐内」而不渲染百分比。
 * Beta：本能力未经真实账号验证（见 docs/specs/minimax-quota.md）。
 */
export function MiniMaxQuotaSection({ providerId }: { providerId: string }) {
  const { intl, locale } = useZCodeIntl();
  const quota = useMiniMaxQuota(providerId);

  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(quota.refresh);
  refreshRef.current = quota.refresh;
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    refreshRef.current();
  }, [refreshTick]);

  const lines = toMiniMaxQuotaLines(quota.windows);
  const errorKind = quota.error;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.minimaxQuota.title" })}
        </h4>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {quota.loading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
      </div>

      {errorKind === "not-configured" ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.minimaxQuota.notConfigured" })}
        </p>
      ) : null}
      {errorKind && errorKind !== "not-configured" ? (
        <p className="mt-2 text-ui-xs text-warning" role="alert">
          {intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
        </p>
      ) : null}

      {lines.length > 0 ? (
        <div className="mt-2 flex w-full gap-2 max-sm:flex-col">
          {lines.map((line) =>
            line.notInPlan ? (
              <div key={line.key} className="min-w-0 flex-1 rounded-lg bg-surface p-3">
                <div className="truncate text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: WINDOW_LABEL_IDS[line.key] })}
                </div>
                <p className="mt-2 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.minimaxQuota.notInPlan" })}
                </p>
              </div>
            ) : (
              <PlanUsageMetricCard
                key={line.key}
                label={intl.formatMessage({ id: WINDOW_LABEL_IDS[line.key] })}
                limit={toUsageLimit(line.usagePercent, line.resetAt)}
                detail={formatMiniMaxRemainingPercent(line.remainingPercent, locale)}
                progressColor={WINDOW_PROGRESS_COLORS[line.key]}
                resetTimeFormat="dateTime"
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
