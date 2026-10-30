import { Loader2 } from "lucide-react";
import type { CommandCodeQuotaErrorKind } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ChatCodingPlanUsageMeter } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { useCommandCodeQuota } from "@/hooks/useCommandCodeQuota.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import {
  formatCommandCodeMoney,
  formatCommandCodeWindowDetail,
  sumCommandCodeCredits,
  toCommandCodeQuotaLines,
} from "@/settings/model-provider-section/commandCodeQuotaDisplay.js";

export interface ChatCommandCodeQuotaConfig {
  providerId: string;
  /** 头部「设置」入口：跳设置页 Command Code 卡片填写 API Key。 */
  onManage: () => void;
}

export function hasChatCommandCodeQuota(config: ChatCommandCodeQuotaConfig | undefined): boolean {
  return Boolean(config?.providerId);
}

const WINDOW_LABEL_IDS = {
  "five-hour": "settings.modelProvider.commandCodeQuota.window.fiveHour",
  weekly: "settings.modelProvider.commandCodeQuota.window.weekly",
} as const;

const ERROR_MESSAGE_IDS: Record<Exclude<CommandCodeQuotaErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.commandCodeQuota.error.credentialStale",
  unavailable: "settings.modelProvider.commandCodeQuota.error.unavailable",
};

const METER_COLORS = {
  "five-hour": "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
} as const;

/**
 * Composer context 浮层里的 Command Code 套餐额度段（5 小时/7 天两条 meter）。
 * 展示件复用官方 ChatCodingPlanUsageMeter；数据走 useCommandCodeQuota —— 本组件只在
 * 浮层展开时挂载，首次请求发生在 hover。exceeded 的窗口不渲染 meter，
 * 只出「已用尽，等待重置」；余额三项已上报时附一行剩余余额。
 */
export function ChatCommandCodeQuotaPanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatCommandCodeQuotaConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const quota = useCommandCodeQuota(config.providerId);
  const errorKind = quota.error;
  const lines = toCommandCodeQuotaLines(quota.windows);
  const creditsTotal = sumCommandCodeCredits(quota.credits);

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.commandCodeQuota.title" })}
        </span>
        <CodingPlanUsageHeaderAction
          error={errorKind}
          loading={quota.loading}
          openLabel={intl.formatMessage({ id: "chat.commandCodeQuota.manage" })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          onUsageClick={config.onManage}
        />
      </div>
      {errorKind === "not-configured" ? (
        <p className="mb-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.commandCodeQuota.notConfigured" })}
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
            line.exceeded ? (
              <div key={line.key} className="min-w-0 space-y-1.5">
                <div className="min-w-0 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: WINDOW_LABEL_IDS[line.key] })}
                </div>
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({
                    id: "settings.modelProvider.commandCodeQuota.exceeded",
                  })}
                </p>
              </div>
            ) : (
              <ChatCodingPlanUsageMeter
                key={line.key}
                color={METER_COLORS[line.key]}
                label={intl.formatMessage({ id: WINDOW_LABEL_IDS[line.key] })}
                percentage={Math.max(0, 100 - line.usagePercent)}
                resetTime={
                  line.resetAt
                    ? formatQuotaResetTime({
                        locale,
                        value: Date.parse(line.resetAt),
                        format: "adaptive",
                      })
                    : undefined
                }
                value={formatCommandCodeWindowDetail(line, locale)}
              />
            ),
          )
        )}
      </div>
      {creditsTotal !== null ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.modelProvider.commandCodeQuota.creditsRemaining" },
            { amount: formatCommandCodeMoney(creditsTotal, locale) },
          )}
        </p>
      ) : null}
    </div>
  );
}
