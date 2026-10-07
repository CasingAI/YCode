import { Loader2 } from "lucide-react";
import type { OpenRouterBalanceErrorKind } from "@zcode/shared";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { useOpenRouterBalance } from "@/hooks/useOpenRouterBalance.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatOpenRouterCurrencyAmount } from "@/settings/model-provider-section/openrouterBalanceDisplay.js";

export interface ChatOpenRouterBalanceConfig {
  providerId: string;
  /** 头部「设置」入口：跳设置页 OpenRouter 卡片填写 API Key。 */
  onManage: () => void;
}

export function hasChatOpenRouterBalance(config: ChatOpenRouterBalanceConfig | undefined): boolean {
  return Boolean(config?.providerId);
}

const ERROR_MESSAGE_IDS: Record<Exclude<OpenRouterBalanceErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.openrouterBalance.error.credentialStale",
  unavailable: "settings.modelProvider.openrouterBalance.error.unavailable",
};

/**
 * Composer context 浮层里的 OpenRouter 余额段（USD 单行）。
 * 版式与 ChatDeepSeekBalancePanel 同构：名称行 + 数值行，无进度条。
 */
export function ChatOpenRouterBalancePanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatOpenRouterBalanceConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const balance = useOpenRouterBalance(config.providerId);
  const errorKind = balance.error;
  const hasAmount = balance.remaining !== null;

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.openrouterBalance.title" })}
        </span>
        <CodingPlanUsageHeaderAction
          error={errorKind}
          loading={balance.loading}
          openLabel={intl.formatMessage({ id: "chat.openrouterBalance.manage" })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          onUsageClick={config.onManage}
        />
      </div>
      {errorKind === "not-configured" ? (
        <p className="mb-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.openrouterBalance.notConfigured" })}
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
      {balance.loading && !hasAmount ? (
        <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
          <Loader2 className="size-3.5 animate-spin" />
          {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
        </div>
      ) : hasAmount ? (
        <div className="grid gap-2">
          <div className="min-w-0 space-y-1.5">
            <div className="min-w-0 space-y-0.5 text-ui-sm">
              <div className="min-w-0 truncate text-foreground-subtle">USD</div>
              <div className="min-w-0 text-ui-sm tabular-nums">
                <span className="font-mono text-foreground">
                  {formatOpenRouterCurrencyAmount(balance.remaining, locale)}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
