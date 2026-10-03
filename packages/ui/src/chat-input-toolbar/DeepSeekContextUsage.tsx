import { Loader2 } from "lucide-react";
import type { DeepSeekBalanceErrorKind } from "@zcode/shared";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { useDeepSeekBalance } from "@/hooks/useDeepSeekBalance.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatDeepSeekAmount,
  toDeepSeekBalanceLines,
} from "@/settings/model-provider-section/deepseekBalanceDisplay.js";

export interface ChatDeepSeekBalanceConfig {
  providerId: string;
  /** 头部「设置」入口：跳设置页 DeepSeek provider 卡片填写 API Key。 */
  onManage: () => void;
}

export function hasChatDeepSeekBalance(
  config: ChatDeepSeekBalanceConfig | undefined,
): boolean {
  return Boolean(config?.providerId);
}

const ERROR_MESSAGE_IDS: Record<
  Exclude<DeepSeekBalanceErrorKind, "not-configured">,
  string
> = {
  "credential-stale":
    "settings.modelProvider.deepseekBalance.error.credentialStale",
  unavailable: "settings.modelProvider.deepseekBalance.error.unavailable",
};

/**
 * Composer context 浮层里的 DeepSeek 余额段。
 *
 * DeepSeek 没有独立凭据可配置，浮层只展示余额与「设置」入口（跳 provider 卡片填 API Key）。
 * 与 ChatOpenCodeUsagePanel 一样只在浮层展开时挂载，首次请求发生在 hover。
 */
export function ChatDeepSeekBalancePanel({
  config,
  intl,
  separated = false,
}: {
  config: ChatDeepSeekBalanceConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  separated?: boolean;
}) {
  const balance = useDeepSeekBalance(config.providerId);
  const errorKind = balance.error;
  const lines = toDeepSeekBalanceLines(balance.balances);

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({
            id: "settings.modelProvider.deepseekBalance.title",
          })}
        </span>
        <CodingPlanUsageHeaderAction
          error={errorKind}
          loading={balance.loading}
          openLabel={intl.formatMessage({ id: "chat.deepseekBalance.manage" })}
          refreshingLabel={intl.formatMessage({
            id: "sidebar.usage.plan.refreshing",
          })}
          updatedLabel={intl.formatMessage({
            id: "sidebar.usage.plan.updated",
          })}
          onUsageClick={config.onManage}
        />
      </div>
      {/* 与设置卡一致：失败时保留上一次的余额，同时在头部下方提示错误。 */}
      {errorKind === "not-configured" ? (
        <p className="mb-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({
            id: "settings.modelProvider.deepseekBalance.notConfigured",
          })}
        </p>
      ) : errorKind ? (
        <div className="mb-2">
          <CodingPlanUsageNotice
            message={intl.formatMessage({ id: ERROR_MESSAGE_IDS[errorKind] })}
            refreshLabel={intl.formatMessage({
              id: "sidebar.usage.plan.refresh",
            })}
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
        // 与 ChatStartPlanBalanceMeter 同构：名称行 + 数值行，无边框容器、无进度条
        // （DeepSeek 不给总额，算不出「剩余/总量」）。
        <div className="grid gap-2">
          {lines.map((line) => (
            <div key={line.currency} className="min-w-0 space-y-1.5">
              <div className="min-w-0 space-y-0.5 text-ui-sm">
                <div className="min-w-0 truncate text-foreground-subtle">
                  {line.currency}
                </div>
                <div className="min-w-0 text-ui-sm tabular-nums">
                  <span className="font-mono text-foreground">
                    {formatDeepSeekAmount(line.total)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {balance.isAvailable === false ? (
        <p className="mt-2 text-ui-xs text-warning" role="alert">
          {intl.formatMessage({
            id: "settings.modelProvider.deepseekBalance.insufficient",
          })}
        </p>
      ) : null}
    </div>
  );
}
