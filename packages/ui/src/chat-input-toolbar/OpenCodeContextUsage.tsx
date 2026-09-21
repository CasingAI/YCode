import { Loader2 } from "lucide-react";
import type { OpenCodeUsageErrorKind, OpenCodeUsageWindow } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ChatCodingPlanUsageMeter } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { useOpenCodeUsage } from "@/hooks/useOpenCodeUsage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";

export interface ChatOpenCodeUsageConfig {
  providerId: string;
  /** 头部「配置」入口：跳设置页 OpenCode provider 卡片管理凭据。 */
  onManage: () => void;
}

export function hasChatOpenCodeUsage(config: ChatOpenCodeUsageConfig | undefined): boolean {
  return Boolean(config?.providerId);
}

// rolling/weekly 与官方 Coding Plan 同义窗口直接复用官方短标签，monthly 用 OpenCode 自有文案。
const WINDOW_LABEL_IDS: Record<OpenCodeUsageWindow["key"], string> = {
  rolling: "sidebar.usage.plan.fiveHour",
  weekly: "sidebar.usage.plan.weekly",
  monthly: "settings.modelProvider.opencodeUsage.window.monthly",
};

const ERROR_MESSAGE_IDS: Record<OpenCodeUsageErrorKind, string> = {
  "not-configured": "settings.modelProvider.opencodeUsage.notConfigured",
  "credential-stale": "settings.modelProvider.opencodeUsage.error.credentialStale",
  "workspace-not-found": "settings.modelProvider.opencodeUsage.error.workspaceNotFound",
  unavailable: "settings.modelProvider.opencodeUsage.error.unavailable",
};

const METER_COLORS: Record<OpenCodeUsageWindow["key"], string> = {
  rolling: "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
  monthly: "var(--color-usage-chart-3)",
};

/**
 * Composer context 浮层里的 OpenCode 套餐用量段（rolling/weekly/monthly 三条 meter）。
 * 展示件复用官方 ChatCodingPlanUsageMeter；数据走 useOpenCodeUsage —— 本组件只在浮层
 * 展开时挂载（HoverCardContent 关闭即卸载），首次请求发生在 hover，不在 composer 挂载时拉额度。
 */
export function ChatOpenCodeUsagePanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatOpenCodeUsageConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const usage = useOpenCodeUsage(config.providerId);
  const errorKind = usage.error;
  const windows = usage.windows;

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "chat.opencodeUsage.title" })}
        </span>
        <CodingPlanUsageHeaderAction
          error={errorKind}
          loading={usage.loading}
          openLabel={intl.formatMessage({ id: "chat.opencodeUsage.manage" })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          onUsageClick={config.onManage}
        />
      </div>
      {/* 与设置卡一致：失败时保留上一次的窗口值，同时在头部下方提示错误。 */}
      {errorKind && errorKind !== "not-configured" ? (
        <div className="mb-2">
          <CodingPlanUsageNotice
            message={intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
            refreshLabel={intl.formatMessage({ id: "sidebar.usage.plan.refresh" })}
            onRefresh={usage.refresh}
          />
        </div>
      ) : null}
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(windows.length))}>
        {usage.loading && windows.length === 0 ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : (
          windows.map((window) => {
            // 页面口径 usagePercent 是已用占比；composer meter 与官方一致展示剩余，需要反转。
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
