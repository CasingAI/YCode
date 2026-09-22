import { Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OpenCodeUsageErrorKind, OpenCodeUsageWindow, UsageQuotaLimit } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenCodeUsage } from "@/hooks/useOpenCodeUsage.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { OpenCodeUsageCredentialForm } from "./OpenCodeUsageCredentialForm.js";
import { PlanUsageMetricCard } from "./StatusCards.js";

// rolling/weekly 与官方 Coding Plan 同义，直接复用官方文案；monthly 官方没有对应卡。
const WINDOW_LABEL_IDS: Record<OpenCodeUsageWindow["key"], string> = {
  rolling: "settings.usage.entitlementFiveHourUsage",
  weekly: "settings.usage.entitlementWeeklyUsage",
  monthly: "settings.modelProvider.opencodeUsage.window.monthly",
};

// 与官方 CodingPlanUsageSummaryCards 相同的图表色板变量。
const WINDOW_PROGRESS_COLORS: Record<OpenCodeUsageWindow["key"], string> = {
  rolling: "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
  monthly: "var(--color-usage-chart-3)",
};

const ERROR_MESSAGE_IDS: Record<OpenCodeUsageErrorKind, string> = {
  "not-configured": "settings.modelProvider.opencodeUsage.notConfigured",
  "credential-stale": "settings.modelProvider.opencodeUsage.error.credentialStale",
  unavailable: "settings.modelProvider.opencodeUsage.error.unavailable",
};

/**
 * OpenCode 窗口 → 官方 PlanUsageMetricCard 的 UsageQuotaLimit 投影。
 * percentage 口径与官方一致：已用占比，卡片内部反转为剩余展示。
 */
function toUsageLimit(window: OpenCodeUsageWindow): UsageQuotaLimit {
  return {
    type: "OPENCODE_USAGE",
    percentage: window.usagePercent,
    usage: window.usage ?? undefined,
    number: window.limit ?? undefined,
    nextResetTime: window.resetAt ? Date.parse(window.resetAt) : undefined,
    usageDetails: [],
  };
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

/**
 * OpenCode provider 卡片上的「剩余额度」区块（statusSection 插槽）。
 * 卡片视觉复用官方 PlanUsageMetricCard；凭据表单见 OpenCodeUsageCredentialForm。
 * 仅在 isOpenCodeProviderTemplateId 的卡片挂载；凭据明文不进本组件状态之外的任何层。
 */
export function OpenCodeUsageSection({ providerId }: { providerId: string }) {
  const { intl } = useZCodeIntl();
  const usage = useOpenCodeUsage(providerId);
  const [configOpen, setConfigOpen] = useState(false);

  // 顶部页面级刷新（模型列表、Coding Plan 权益共用的那个按钮）也刷新本卡片的用量：
  // tick 只在点击刷新时递增，因此记住首次观测值即可，挂载时不会多打一次请求。
  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(usage.refresh);
  refreshRef.current = usage.refresh;
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    refreshRef.current();
  }, [refreshTick]);

  const hint = usage.hint;
  // 凭据存在性要等 hint RPC 返回；未确定前不渲染配置表单，避免首屏闪「未配置」形态。
  const configured = Boolean(hint);
  const errorKind = usage.error;
  const windows = usage.windows;
  const visibleForm = configOpen || (!usage.hintLoading && !configured);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
        {/* 「修改配置」靠右对齐，与标题分列两端。 */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 只负责打开：表单展开后由表单自己的「取消」收起，
              否则按钮写着「修改配置」却是关闭动作。 */}
          {configured && !configOpen ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto p-0 text-ui-xs"
              onClick={() => setConfigOpen(true)}
            >
              {intl.formatMessage({
                id: "settings.modelProvider.opencodeUsage.edit",
              })}
            </Button>
          ) : null}
          {usage.loading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
      </div>

      {errorKind && errorKind !== "not-configured" ? (
        <p className="mt-2 text-ui-xs text-warning" role="alert">
          {intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
        </p>
      ) : null}

      {windows.length > 0 ? (
        <div className="mt-2 flex w-full gap-2 max-sm:flex-col">
          {windows.map((window) => (
            <PlanUsageMetricCard
              key={window.key}
              label={intl.formatMessage({ id: WINDOW_LABEL_IDS[window.key] })}
              limit={toUsageLimit(window)}
              detail={
                window.usage !== null && window.limit
                  ? `${formatTokenCount(window.usage)} / ${formatTokenCount(window.limit)}`
                  : undefined
              }
              progressColor={WINDOW_PROGRESS_COLORS[window.key]}
              resetTimeFormat={window.key === "rolling" ? "dateTime" : "date"}
            />
          ))}
        </div>
      ) : null}

      {visibleForm ? (
        <OpenCodeUsageCredentialForm
          configured={configured}
          cookieTail={hint?.cookieTail ?? ""}
          initialWorkspaceId={hint?.workspaceId ?? ""}
          saving={usage.saving}
          workspaceList={usage.workspaceList}
          workspaceListLoading={usage.workspaceListLoading}
          fetchWorkspaces={usage.fetchWorkspaces}
          saveCredential={usage.saveCredential}
          clearCredential={usage.clearCredential}
          onClose={() => setConfigOpen(false)}
        />
      ) : null}
    </div>
  );
}
