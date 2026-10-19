import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useChatGPTPlanController } from "./ChatGPTPlanStateProvider.js";

/**
 * 统一供应商卡片底部的账户行（docs/specs/openai-chatgpt-plan-provider.md
 * 「详情接入统一供应商卡片」）。与 CLI Proxy 渠道同位、同款小字灰度：
 * 「当前账号：<account>」+ 右侧账户操作，账户身份不再单独占一块大卡片。
 */
export function ChatGPTPlanAccountFooter() {
  const { state, busy, run } = useChatGPTPlanController();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.chatGPTPlan.${key}` });
  const accounts = state?.accounts ?? [];
  if (accounts.length === 0) return null;
  const reauthorize = (accountId: string) => {
    void run(async (service) => {
      const result = await service.startLogin(accountId);
      platform.openExternal(result.authorizeUrl);
    });
  };
  return (
    <div className="space-y-1 pt-1">
      {accounts.map((account) => {
        const isActive = state?.activeAccountId === account.id;
        return (
          <div
            key={account.id}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            data-testid="model-provider-chatgpt-plan-account"
          >
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtlest">
              {intl.formatMessage(
                { id: "settings.modelProvider.cliproxyAccount" },
                { accounts: account.label },
              )}
            </span>
            {isActive ? (
              <span className="text-ui-xs text-foreground-subtlest">{t("selected")}</span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !account.connected}
                onClick={() => void run((s) => s.selectAccount(account.id))}
              >
                {t("select")}
              </Button>
            )}
            {account.connected && account.sharing ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => reauthorize(account.id)}
              >
                {t("reauthorize")}
              </Button>
            )}
            {account.connected ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run((s) => s.logout(account.id))}
              >
                {t("logout")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => void run((s) => s.deleteAccount(account.id))}
            >
              {t("remove")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
