import { Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OpenCodeUsageErrorKind } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenCodeUsage } from "@/hooks/useOpenCodeUsage.js";
import { useOpenCodeZenBalance } from "@/hooks/useOpenCodeZenBalance.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import {
  formatOpenCodeZenCurrencyAmount,
  toOpenCodeZenBalanceLines,
} from "./openCodeZenBalanceDisplay.js";
import { OpenCodeUsageCredentialForm } from "./OpenCodeUsageCredentialForm.js";

const ERROR_MESSAGE_IDS: Record<Exclude<OpenCodeUsageErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.opencodeUsage.error.credentialStale",
  unavailable: "settings.modelProvider.opencodeUsage.error.unavailable",
};

/**
 * OpenCode Zen provider 卡片上的「余额」区块（statusSection 插槽）。
 *
 * Zen 按量付费没有套餐窗口，余额走 console `/console/api/billing/status`，
 * 与 Go 套餐共用同一套 Cookie + Workspace 凭据体系（凭据记录按 providerId 隔离，
 * Go 与 Zen 是两个 provider，各自粘一次 Cookie，互不串扰）——因此凭据表单直接复用
 * `OpenCodeUsageCredentialForm`，余额版式对齐 DeepSeek（币种 + 金额两行，无进度条）。
 */
export function OpenCodeZenBalanceSection({ providerId }: { providerId: string }) {
  const { intl, locale } = useZCodeIntl();
  const balance = useOpenCodeZenBalance(providerId);
  // 凭据表单的 Workspace 下拉与保存逻辑复用 Go 的 hook（同一凭据体系）。
  const credential = useOpenCodeUsage(providerId);
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
                  {formatOpenCodeZenCurrencyAmount(line.amount, line.currency, locale)}
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
