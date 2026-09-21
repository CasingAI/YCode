import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OpenCodeUsageErrorKind, OpenCodeUsageWindow, UsageQuotaLimit } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenCodeUsage } from "@/hooks/useOpenCodeUsage.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
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
 * 卡片视觉复用官方 PlanUsageMetricCard；凭据配置/错误提示是本区块特有部分。
 * 仅在 isOpenCodeProviderTemplateId 的卡片挂载；凭据明文不进本组件状态之外的任何层。
 */
export function OpenCodeUsageSection({ providerId }: { providerId: string }) {
  const { intl } = useZCodeIntl();
  const usage = useOpenCodeUsage(providerId);
  const [configOpen, setConfigOpen] = useState(false);
  const [cookieDraft, setCookieDraft] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [formErrorId, setFormErrorId] = useState<string | null>(null);

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

  const handleSave = async () => {
    const cookieInput = cookieDraft.trim();
    // 已配置时允许留空 = 沿用已保存的 Cookie（改 Workspace ID / 重新保存不必重贴）。
    if (!cookieInput && !configured) {
      setFormErrorId("settings.modelProvider.opencodeUsage.error.invalidCookie");
      return;
    }
    // Workspace ID 留空是允许的：opencode.ai 的 /auth 会跳到当前账号的默认 Workspace，
    // 凭据本身就能定位（见 opencodeUsageService.resolveWorkspaceId），无需用户去抄 ID。
    setFormErrorId(null);
    try {
      await usage.saveCredential({
        authCookie: cookieInput,
        workspaceId: workspaceDraft,
      });
      // 保存成功后清空草稿并折叠表单；cookie 不在任何非凭据层留存。
      setCookieDraft("");
      setWorkspaceDraft("");
      setConfigOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFormErrorId(
        message.includes("workspace_id")
          ? "settings.modelProvider.opencodeUsage.error.invalidWorkspaceId"
          : "settings.modelProvider.opencodeUsage.error.invalidCookie",
      );
    }
  };

  /** 打开配置表单时带出已保存的 Workspace ID，Cookie 不回显故留空即保留。 */
  const openConfigForm = () => {
    setWorkspaceDraft(hint?.workspaceId ?? "");
    setFormErrorId(null);
    setConfigOpen(true);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
        {configured ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto shrink-0 p-0 text-ui-xs"
            onClick={() => (configOpen ? setConfigOpen(false) : openConfigForm())}
          >
            {intl.formatMessage({ id: "settings.modelProvider.opencodeUsage.edit" })}
          </Button>
        ) : null}
        {usage.loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
        ) : null}
        {configured ? (
          <Button type="button" variant="ghost" size="icon-sm" onClick={usage.refresh}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
        ) : null}
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
        <div className="mt-3 space-y-2">
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.opencodeUsage.notConfigured" })}
          </p>
          <label className="block space-y-1">
            <span className="text-ui-xs text-foreground">
              {intl.formatMessage({ id: "settings.modelProvider.opencodeUsage.cookieLabel" })}
            </span>
            <Input
              type="password"
              autoComplete="off"
              className="h-9"
              placeholder={intl.formatMessage(
                {
                  id: configured
                    ? "settings.modelProvider.opencodeUsage.cookiePlaceholderKeep"
                    : "settings.modelProvider.opencodeUsage.cookiePlaceholder",
                },
                { tail: hint?.cookieTail ?? "" },
              )}
              value={cookieDraft}
              onChange={(event) => setCookieDraft(event.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-ui-xs text-foreground">
              {intl.formatMessage({
                id: "settings.modelProvider.opencodeUsage.workspaceIdLabel",
              })}
            </span>
            <Input
              type="text"
              autoComplete="off"
              className="h-9"
              placeholder={intl.formatMessage({
                id: "settings.modelProvider.opencodeUsage.workspaceIdPlaceholder",
              })}
              value={workspaceDraft}
              onChange={(event) => setWorkspaceDraft(event.target.value)}
            />
          </label>
          {formErrorId ? (
            <p className="text-ui-xs text-warning" role="alert">
              {intl.formatMessage({ id: formErrorId })}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={usage.saving}
              onClick={() => void handleSave()}
            >
              {intl.formatMessage({ id: "settings.modelProvider.opencodeUsage.save" })}
            </Button>
            {configured ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfigOpen(false);
                    setFormErrorId(null);
                    setCookieDraft("");
                    setWorkspaceDraft("");
                  }}
                >
                  {intl.formatMessage({ id: "settings.modelProvider.opencodeUsage.cancel" })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-warning"
                  onClick={() => void usage.clearCredential()}
                >
                  {intl.formatMessage({ id: "settings.modelProvider.opencodeUsage.clear" })}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
