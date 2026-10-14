import { Loader2 } from "lucide-react";
import type { CliProxyQuotaErrorKind, CliProxyQuotaWindow } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ChatCodingPlanUsageMeter } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { useCliProxyQuota } from "@/hooks/useCliProxyQuota.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";

/**
 * Composer context 浮层里的 CLI Proxy（Codex）额度段。
 * 与 OpenCode 同款范式：展示件复用官方 CodingPlanUsageMeter；数据走 useCliProxyQuota
 * —— 只在浮层展开（组件挂载）时拉取，不在 composer 挂载时拉额度。
 * 上游代理是实例级共享：多账号条目的窗口会合并展示（服务层已按渠道合并）。
 */
export interface ChatCliProxyQuotaConfig {
  providerId: string;
  /** 头部「配置」入口：跳设置页 CLI Proxy provider 卡片（重新登录/切换账号等）。 */
  onManage: () => void;
}

export function hasChatCliProxyQuota(config: ChatCliProxyQuotaConfig | undefined): boolean {
  return Boolean(config?.providerId);
}

// 与官方 Coding Plan 同义窗口复用同一批短标签；other 用 CLI Proxy 自有文案。
const WINDOW_LABEL_IDS: Record<CliProxyQuotaWindow["key"], string> = {
  "five-hour": "sidebar.usage.plan.fiveHour",
  weekly: "sidebar.usage.plan.weekly",
  other: "settings.modelProvider.cliproxyQuota.window.other",
};

const ERROR_MESSAGE_IDS: Record<CliProxyQuotaErrorKind, string> = {
  "proxy-stopped": "settings.modelProvider.cliproxyQuota.proxyStopped",
  "not-logged-in": "settings.modelProvider.cliproxyQuota.noObservation",
  "no-observation": "settings.modelProvider.cliproxyQuota.noObservation",
  unavailable: "settings.modelProvider.cliproxyQuota.unavailable",
};

const METER_COLORS: Record<CliProxyQuotaWindow["key"], string> = {
  "five-hour": "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
  other: "var(--color-usage-chart-3)",
};

export function ChatCliProxyQuotaPanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatCliProxyQuotaConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const quota = useCliProxyQuota(config.providerId);
  const errorKind = quota.error;
  const windows = quota.windows;

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "chat.cliproxyQuota.title" })}
        </span>
        <CodingPlanUsageHeaderAction
          error={errorKind}
          loading={quota.loading}
          openLabel={intl.formatMessage({ id: "chat.cliproxyQuota.manage" })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          onUsageClick={config.onManage}
        />
      </div>
      {errorKind ? (
        <div className="mb-2">
          <CodingPlanUsageNotice
            message={intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
            refreshLabel={intl.formatMessage({ id: "sidebar.usage.plan.refresh" })}
            onRefresh={quota.refresh}
          />
        </div>
      ) : null}
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(windows.length))}>
        {quota.loading && windows.length === 0 ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : (
          windows.map((window) => {
            // usagePercent 是已用占比；meter 与官方一致展示剩余，需要反转。
            const remainingPercentage = Math.max(0, Math.min(100, 100 - window.usagePercent));
            return (
              <ChatCodingPlanUsageMeter
                key={window.key}
                color={METER_COLORS[window.key]}
                label={intl.formatMessage({ id: WINDOW_LABEL_IDS[window.key] })}
                percentage={remainingPercentage}
                resetTime={
                  window.resetAt
                    ? formatQuotaResetTime({
                        locale,
                        value: Date.parse(window.resetAt),
                        format: "adaptive",
                      })
                    : undefined
                }
                value={`${new Intl.NumberFormat(locale, {
                  maximumFractionDigits: remainingPercentage >= 10 ? 0 : 1,
                }).format(remainingPercentage)}%`}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
