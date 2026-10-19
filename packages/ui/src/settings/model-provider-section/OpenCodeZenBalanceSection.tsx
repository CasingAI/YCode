import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { OpenCodeUsageErrorKind } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenCodeZenBalance } from "@/hooks/useOpenCodeZenBalance.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { formatCurrencyAmount } from "./openCodeCurrencyDisplay.js";
import { toOpenCodeZenBalanceLines } from "./openCodeZenBalanceDisplay.js";

const ERROR_MESSAGE_IDS: Record<OpenCodeUsageErrorKind, string> = {
  "not-configured": "settings.modelProvider.opencodeZenBalance.notConfigured",
  "credential-stale": "settings.modelProvider.opencodeUsage.error.apiKeyRejected",
  "subscription-required": "settings.modelProvider.opencodeUsage.error.subscriptionRequired",
  unavailable: "settings.modelProvider.opencodeUsage.error.unavailable",
};

/** OpenCode Zen provider 卡片上的余额区块；直接复用该 Provider 的 API Key，不另存凭据。 */
export function OpenCodeZenBalanceSection({
  providerId,
  configRevision,
}: {
  providerId: string;
  configRevision?: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const balance = useOpenCodeZenBalance(providerId);
  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(balance.refresh);
  refreshRef.current = balance.refresh;
  const observedConfigRevisionRef = useRef(configRevision);
  useEffect(() => {
    if (configRevision === observedConfigRevisionRef.current) return;
    observedConfigRevisionRef.current = configRevision;
    // Provider API Key 保存后立刻查询新账号，不能继续显示旧 Key 的余额。
    refreshRef.current();
  }, [configRevision]);
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    refreshRef.current();
  }, [refreshTick]);

  const lines = toOpenCodeZenBalanceLines(balance.balances);
  const errorKind = balance.error;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.opencodeZenBalance.title" })}
        </h4>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {balance.loading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
      </div>

      {errorKind ? (
        <p className="mt-2 text-ui-xs text-warning" role="status">
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
    </div>
  );
}
