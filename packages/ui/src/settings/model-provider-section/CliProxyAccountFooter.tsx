import { useCliProxyQuota } from "@/hooks/useCliProxyQuota.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * CLI Proxy 提供商卡片底部的当前账号提示（灰色小字）。
 * 动机（用户 2026-10-14）：凭据目录/代理状态可能被外部改动，账号不看清楚容易搞错；
 * 数据与额度环同源（管理面 credentials 的 email/account），被动观测、不轮询。
 */
export function CliProxyAccountFooter({ providerId }: { providerId: string }) {
  const { intl } = useZCodeIntl();
  const quota = useCliProxyQuota(providerId);
  if (quota.accounts.length === 0) return null;
  return (
    <div
      className="truncate pt-1 text-ui-sm text-foreground-subtlest"
      data-testid="model-provider-cliproxy-account"
    >
      {intl.formatMessage(
        { id: "settings.modelProvider.cliproxyAccount" },
        { accounts: quota.accounts.join(intl.formatMessage({ id: "common.listSeparator" })) },
      )}
    </div>
  );
}
