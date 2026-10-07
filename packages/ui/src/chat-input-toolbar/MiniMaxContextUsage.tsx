import { Loader2 } from "lucide-react";
import type { MiniMaxQuotaErrorKind } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ChatCodingPlanUsageMeter } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { useMiniMaxQuota } from "@/hooks/useMiniMaxQuota.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import {
  formatMiniMaxRemainingPercent,
  toMiniMaxQuotaLines,
} from "@/settings/model-provider-section/minimaxQuotaDisplay.js";

export interface ChatMiniMaxQuotaConfig {
  providerId: string;
  /** 头部「设置」入口：跳设置页 MiniMax Token Plan 卡片填写订阅 Key。 */
  onManage: () => void;
}

export function hasChatMiniMaxQuota(config: ChatMiniMaxQuotaConfig | undefined): boolean {
  return Boolean(config?.providerId);
}

const WINDOW_LABEL_IDS = {
  interval: "settings.modelProvider.minimaxQuota.window.interval",
  weekly: "settings.modelProvider.minimaxQuota.window.weekly",
} as const;

const ERROR_MESSAGE_IDS: Record<Exclude<MiniMaxQuotaErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.minimaxQuota.error.credentialStale",
  unavailable: "settings.modelProvider.minimaxQuota.error.unavailable",
};

const METER_COLORS = {
  interval: "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
} as const;

/**
 * Composer context 浮层里的 MiniMax 套餐额度段（interval/weekly 两条 meter）。
 * 展示件复用官方 ChatCodingPlanUsageMeter；数据走 useMiniMaxQuota —— 本组件只在浮层
 * 展开时挂载，首次请求发生在 hover。status === 3 的窗口不渲染 meter，只出「不在套餐内」。
 */
export function ChatMiniMaxQuotaPanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatMiniMaxQuotaConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const quota = useMiniMaxQuota(config.providerId);
  const errorKind = quota.error;
  const lines = toMiniMaxQuotaLines(quota.windows);

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.minimaxQuota.title" })}
        </span>
        <CodingPlanUsageHeaderAction
          error={errorKind}
          loading={quota.loading}
          openLabel={intl.formatMessage({ id: "chat.minimaxQuota.manage" })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          onUsageClick={config.onManage}
        />
      </div>
      {errorKind === "not-configured" ? (
        <p className="mb-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.minimaxQuota.notConfigured" })}
        </p>
      ) : errorKind ? (
        <div className="mb-2">
          <CodingPlanUsageNotice
            message={intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
            refreshLabel={intl.formatMessage({ id: "sidebar.usage.plan.refresh" })}
            onRefresh={quota.refresh}
          />
        </div>
      ) : null}
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(lines.length))}>
        {quota.loading && lines.length === 0 ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : (
          lines.map((line) =>
            line.notInPlan ? (
              <div key={line.key} className="min-w-0 space-y-1.5">
                <div className="min-w-0 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: WINDOW_LABEL_IDS[line.key] })}
                </div>
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.minimaxQuota.notInPlan" })}
                </p>
              </div>
            ) : (
              <ChatCodingPlanUsageMeter
                key={line.key}
                color={METER_COLORS[line.key]}
                label={intl.formatMessage({ id: WINDOW_LABEL_IDS[line.key] })}
                percentage={line.remainingPercent}
                resetTime={
                  line.resetAt
                    ? formatQuotaResetTime({
                        locale,
                        value: Date.parse(line.resetAt),
                        format: "adaptive",
                      })
                    : undefined
                }
                value={formatMiniMaxRemainingPercent(line.remainingPercent, locale)}
              />
            ),
          )
        )}
      </div>
    </div>
  );
}
