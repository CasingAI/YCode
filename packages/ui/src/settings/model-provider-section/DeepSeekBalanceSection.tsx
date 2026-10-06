import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { DeepSeekBalanceErrorKind } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useDeepSeekBalance } from "@/hooks/useDeepSeekBalance.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { formatDeepSeekCurrencyAmount, toDeepSeekBalanceLines } from "./deepseekBalanceDisplay.js";

const ERROR_MESSAGE_IDS: Record<Exclude<DeepSeekBalanceErrorKind, "not-configured">, string> = {
  "credential-stale": "settings.modelProvider.deepseekBalance.error.credentialStale",
  unavailable: "settings.modelProvider.deepseekBalance.error.unavailable",
};

/**
 * DeepSeek provider 卡片上的「余额」区块（statusSection 插槽）。
 *
 * 版式对齐 OpenCodeUsageSection：标题行左端是标题、右端只有加载指示，刷新走模型设置页
 * 顶部的页面级按钮。DeepSeek 没有独立凭据——查询用的就是上方 provider 表单里的 API Key，
 * 因此这里没有配置表单，未配置时只给一行引导。
 */
export function DeepSeekBalanceSection({ providerId }: { providerId: string }) {
  // locale 要跟着货币符号走：中文界面显示 ¥，英文界面 Intl 会给无歧义的 CN¥。
  const { intl, locale } = useZCodeIntl();
  const balance = useDeepSeekBalance(providerId);

  // 顶部页面级刷新（模型列表、余额共用的那个按钮）也刷新本区块；tick 只在点击时递增，
  // 因此记住首次观测值即可，挂载时不会多打一次请求。
  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(balance.refresh);
  refreshRef.current = balance.refresh;
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    refreshRef.current();
  }, [refreshTick]);

  const lines = toDeepSeekBalanceLines(balance.balances);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({
            id: "settings.modelProvider.deepseekBalance.title",
          })}
        </h4>
        {balance.loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
        ) : null}
      </div>

      {balance.error === "not-configured" ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({
            id: "settings.modelProvider.deepseekBalance.notConfigured",
          })}
        </p>
      ) : null}
      {balance.error && balance.error !== "not-configured" ? (
        <p className="mt-2 text-ui-xs text-warning" role="alert">
          {intl.formatMessage({ id: ERROR_MESSAGE_IDS[balance.error] })}
        </p>
      ) : null}

      {lines.length > 0 ? (
        <div className="mt-2 flex w-full gap-2 max-sm:flex-col">
          {lines.map((line) => (
            // 与 StartPlanBalanceLimit 同构：无边框浅底桶，名称行 + 大字数值行。
            // 金额自带货币符号（¥19.54），名称行仍是币种代码。
            // DeepSeek 不给总额，所以没有官方那张卡的进度条与百分比。
            <div key={line.currency} className="min-w-0 flex-1 rounded-lg bg-surface p-3">
              <div className="truncate text-ui-base font-medium text-foreground">
                {line.currency}
              </div>
              <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-ui-lg font-semibold leading-none text-foreground">
                  {formatDeepSeekCurrencyAmount(line.total, line.currency, locale)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* is_available=false 只在拿到成功快照时成立；余额照常展示，额外提示额度不足。 */}
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
