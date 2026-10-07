import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { OpenRouterBalanceErrorKind } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenRouterBalance } from "@/hooks/useOpenRouterBalance.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { formatOpenRouterCurrencyAmount } from "./openrouterBalanceDisplay.js";

const ERROR_MESSAGE_IDS: Record<Exclude<OpenRouterBalanceErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.openrouterBalance.error.credentialStale",
  unavailable: "settings.modelProvider.openrouterBalance.error.unavailable",
};

/**
 * OpenRouter provider 卡片上的「余额」区块（statusSection 插槽）。
 *
 * 版式对齐 DeepSeekBalanceSection：无边框浅底桶，币种行 + 大字数值行，无进度条。
 * 单 USD 币种，剩余额度由 host 侧相减得出。负值如实展示。
 * Beta：本能力未经真实账号验证（见 docs/specs/openrouter-balance.md）。
 */
export function OpenRouterBalanceSection({ providerId }: { providerId: string }) {
  const { intl, locale } = useZCodeIntl();
  const balance = useOpenRouterBalance(providerId);

  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(balance.refresh);
  refreshRef.current = balance.refresh;
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    refreshRef.current();
  }, [refreshTick]);

  const hasAmount = balance.remaining !== null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.openrouterBalance.title" })}
        </h4>
        {balance.loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
        ) : null}
      </div>

      {balance.error === "not-configured" ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.openrouterBalance.notConfigured" })}
        </p>
      ) : null}
      {balance.error && balance.error !== "not-configured" ? (
        <p className="mt-2 text-ui-xs text-warning" role="alert">
          {intl.formatMessage({ id: ERROR_MESSAGE_IDS[balance.error] })}
        </p>
      ) : null}

      {hasAmount ? (
        <div className="mt-2 flex w-full gap-2 max-sm:flex-col">
          <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
            <div className="truncate text-ui-base font-medium text-foreground">USD</div>
            <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-ui-lg font-semibold leading-none text-foreground">
                {formatOpenRouterCurrencyAmount(balance.remaining, locale)}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
