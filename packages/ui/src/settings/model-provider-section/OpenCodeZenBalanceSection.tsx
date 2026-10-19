import { Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OpenCodeUsageErrorKind } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenCodeUsage } from "@/hooks/useOpenCodeUsage.js";
import { useOpenCodeZenBalance } from "@/hooks/useOpenCodeZenBalance.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { formatCurrencyAmount } from "./openCodeCurrencyDisplay.js";
import { toOpenCodeZenBalanceLines } from "./openCodeZenBalanceDisplay.js";
import { OpenCodeUsageCredentialForm } from "./OpenCodeUsageCredentialForm.js";

const ERROR_MESSAGE_IDS: Record<Exclude<OpenCodeUsageErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.opencodeUsage.error.credentialStale",
  "subscription-required": "settings.modelProvider.opencodeUsage.error.unavailable",
  unavailable: "settings.modelProvider.opencodeUsage.error.unavailable",
};

/**
 * OpenCode Zen provider 卡片上的「余额」区块（statusSection 插槽）。
 *
 * Zen 按量付费没有套餐窗口，余额走 console `/console/api/billing/status`，仍需要
 * Zen 自己的 Cookie + Workspace 配置。凭据表单复用 `OpenCodeUsageCredentialForm`，
 * 但只使用 credentialsOnly 模式，不触发 Go 套餐额度查询。余额版式对齐 DeepSeek。
 */
export function OpenCodeZenBalanceSection({ providerId }: { providerId: string }) {
  const { intl, locale } = useZCodeIntl();
  const balance = useOpenCodeZenBalance(providerId);
  // 仅复用 Workspace 下拉与 Cookie 保存逻辑，不查询 Go 套餐额度。
  const credential = useOpenCodeUsage(providerId, { credentialsOnly: true });
  const [configOpen, setConfigOpen] = useState(false);

  // 顶部页面级刷新也刷新本区块；tick 只在点击时递增，挂载时不会多打一次请求。
  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(balance.refresh);
  refreshRef.current = balance.refresh;
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    refreshRef.current();
  }, [refreshTick]);

  const lines = toOpenCodeZenBalanceLines(balance.balances);
  const errorKind = balance.error;
  const hint = credential.hint;
  const configured = Boolean(hint);
  const visibleForm = configOpen || (!credential.hintLoading && !configured);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.opencodeZenBalance.title" })}
        </h4>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {configured && !configOpen ? (
            <button
              type="button"
              className="h-auto p-0 text-ui-xs text-foreground-subtle hover:text-foreground"
              onClick={() => setConfigOpen(true)}
            >
              {intl.formatMessage({ id: "settings.modelProvider.opencodeUsage.edit" })}
            </button>
          ) : null}
          {balance.loading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
      </div>

      {errorKind && errorKind !== "not-configured" ? (
        <p className="mt-2 text-ui-xs text-warning" role="alert">
          {intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
        </p>
      ) : null}

      {lines.length > 0 ? (
        <div className="mt-2 flex w-full gap-2 max-sm:flex-col">
          {lines.map((line) => (
            <div key={line.currency} className="min-w-0 flex-1 rounded-lg bg-surface p-3">
              <div className="truncate text-ui-base font-medium text-foreground">
                {line.currency}
              </div>
              <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-ui-lg font-semibold leading-none text-foreground">
                  {formatCurrencyAmount(line.amount, line.currency, locale)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {visibleForm ? (
        <OpenCodeUsageCredentialForm
          configured={configured}
          cookieTail={hint?.cookieTail ?? ""}
          initialWorkspaceId={hint?.workspaceId ?? ""}
          saving={credential.saving}
          workspaceList={credential.workspaceList}
          workspaceListLoading={credential.workspaceListLoading}
          fetchWorkspaces={credential.fetchWorkspaces}
          saveCredential={credential.saveCredential}
          clearCredential={credential.clearCredential}
          onClose={() => setConfigOpen(false)}
        />
      ) : null}
    </div>
  );
}
