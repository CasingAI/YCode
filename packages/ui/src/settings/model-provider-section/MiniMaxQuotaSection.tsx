import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MiniMaxQuotaErrorKind, UsageQuotaLimit } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMiniMaxQuota } from "@/hooks/useMiniMaxQuota.js";
import {
  useModelProviderRefreshTick,
  useReportModelProviderPending,
} from "@/settings/model-provider-section/RefreshSignal.js";
import { scheduleProviderQuotaRefresh } from "@/settings/model-provider-section/providerQuotaRefreshSchedule.js";
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
export function MiniMaxQuotaSection({
  providerId,
  configRevision,
}: {
  providerId: string;
  /** provider 配置版本：变化表示 API Key 等配置被改动，需要重新取数。 */
  configRevision?: number;
}) {
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

  // 配置变更（典型是先建 provider、再填订阅 Key）后自动重查：
  // 合并 1s 内的连续变更，并用 refresh=true 绕开 host 侧 60s 节流缓存，
  // 不让用户靠切页面或等满 TTL 才能看到额度。
  const observedRevisionRef = useRef(configRevision);
  useEffect(() => {
    const previousRevision = observedRevisionRef.current;
    if (configRevision === previousRevision) return;
    observedRevisionRef.current = configRevision;
    // 视图首帧拿到 revision 不算配置变更：那是「刚知道当前版本」，不是用户改了配置。
    if (previousRevision === undefined || configRevision === undefined) return;
    const schedule = scheduleProviderQuotaRefresh({ run: () => refreshRef.current() });
    return () => schedule.cancel();
  }, [configRevision]);

  // 查询在途时上报页面级刷新信号：顶部刷新按钮同步进入加载态。
  useReportModelProviderPending(quota.loading);

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

      {/* 没有任何额度值、又没有错误可提示时给出「正在查询」文案：空白卡片无法让用户
          判断是没额度还是还没查完。host 侧要么返回窗口、要么返回错误类别，
          所以「无值且无错误」只可能出现在查询在途（含首帧尚未返回）时。 */}
      {lines.length === 0 && !errorKind ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.minimaxQuota.loading" })}
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
