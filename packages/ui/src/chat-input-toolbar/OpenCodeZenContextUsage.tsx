import { Loader2 } from "lucide-react";
import type { OpenCodeUsageErrorKind } from "@zcode/shared";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { useOpenCodeZenBalance } from "@/hooks/useOpenCodeZenBalance.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatOpenCodeZenCurrencyAmount,
  toOpenCodeZenBalanceLines,
} from "@/settings/model-provider-section/openCodeZenBalanceDisplay.js";

export interface ChatOpenCodeZenBalanceConfig {
  providerId: string;
  /** 头部「配置」入口：跳设置页 Zen 卡片管理 Cookie 凭据。 */
  onManage: () => void;
}

export function hasChatOpenCodeZenBalance(
  config: ChatOpenCodeZenBalanceConfig | undefined,
): boolean {
  return Boolean(config?.providerId);
}

const ERROR_MESSAGE_IDS: Record<Exclude<OpenCodeUsageErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.opencodeUsage.error.credentialStale",
  unavailable: "settings.modelProvider.opencodeUsage.error.unavailable",
};

/**
 * Composer context 浮层里的 Zen 余额段。
 * 与 ChatDeepSeekBalancePanel 同构：名称行 + 数值行，无进度条。
 * 凭据走 Cookie 体系，「配置」入口跳设置页 Zen 卡片。
 */
export function ChatOpenCodeZenBalancePanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatOpenCodeZenBalanceConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const balance = useOpenCodeZenBalance(config.providerId);
  const errorKind = balance.error;
  const lines = toOpenCodeZenBalanceLines(balance.balances);

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.opencodeZenBalance.title" })}
        </span>
        <CodingPlanUsageHeaderAction
          error={errorKind}
          loading={balance.loading}
          openLabel={intl.formatMessage({ id: "chat.opencodeZenBalance.manage" })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          onUsageClick={config.onManage}
        />
      </div>
      {errorKind === "not-configured" ? (
        <p className="mb-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.opencodeZenBalance.notConfigured" })}
        </p>
      ) : errorKind ? (
        <div className="mb-2">
          <CodingPlanUsageNotice
            message={intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
            refreshLabel={intl.formatMessage({ id: "sidebar.usage.plan.refresh" })}
            onRefresh={balance.refresh}
          />
        </div>
      ) : null}
      {balance.loading && lines.length === 0 ? (
        <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
          <Loader2 className="size-3.5 animate-spin" />
          {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
        </div>
      ) : (
        <div className="grid gap-2">
          {lines.map((line) => (
            <div key={line.currency} className="min-w-0 space-y-1.5">
              <div className="min-w-0 space-y-0.5 text-ui-sm">
                <div className="min-w-0 truncate text-foreground-subtle">{line.currency}</div>
                <div className="min-w-0 text-ui-sm tabular-nums">
                  <span className="font-mono text-foreground">
                    {formatOpenCodeZenCurrencyAmount(line.amount, line.currency, locale)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
