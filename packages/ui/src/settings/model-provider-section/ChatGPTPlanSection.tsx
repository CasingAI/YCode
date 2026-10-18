import { CHATGPT_PLAN_USAGE_URL } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useChatGPTPlan } from "@/hooks/useChatGPTPlan.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ChatGPTPlanSection({ enabled }: { enabled: boolean }) {
  const { available, state, busy, failed, run } = useChatGPTPlan(enabled);
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.chatGPTPlan.${key}` });
  const login = (accountId?: string) => {
    void run(async (service) => {
      const result = await service.startLogin(accountId);
      platform.openExternal(result.authorizeUrl);
    });
  };
  return (
    <section
      aria-label="OpenAI (ChatGPT Plan)"
      className="space-y-3 rounded-lg border border-border bg-card p-4 text-ui-base"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">OpenAI (ChatGPT Plan)</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => platform.openExternal(CHATGPT_PLAN_USAGE_URL)}
        >
          {t("manageUsage")}
        </Button>
      </div>
      <p className="text-foreground-subtle">{t(available ? "description" : "localOnly")}</p>
      {available && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || state?.pending} onClick={() => login()}>
              {t("continue")}
            </Button>
            {state?.pending && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run((s) => s.cancelLogin())}
              >
                {t("cancel")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !state?.activeAccountId}
              onClick={() => void run((s) => s.refreshModels())}
            >
              {t("refreshModels")}
            </Button>
          </div>
          {state?.accounts.map((account) => (
            <div
              key={account.id}
              className="flex flex-wrap items-center gap-2 border-t border-border pt-2"
            >
              <span className="min-w-0 flex-1 break-all">{account.label}</span>
              {account.errorCode && (
                <span role="alert" className="text-ui-caption text-destructive">
                  {t("failed")} ({account.errorCode})
                </span>
              )}
              <span className="text-ui-caption text-foreground-subtle">
                {t(
                  !account.connected
                    ? "signedOut"
                    : account.sharing
                      ? "planEnabled"
                      : "permissionRequired",
                )}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !account.connected || state.activeAccountId === account.id}
                onClick={() => void run((s) => s.selectAccount(account.id))}
              >
                {t(state.activeAccountId === account.id ? "selected" : "select")}
              </Button>
              {(!account.connected || !account.sharing) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => login(account.id)}
                >
                  {t("reconnect")}
                </Button>
              )}
              {account.connected && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run((s) => s.logout(account.id))}
                >
                  {t("logout")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run((s) => s.deleteAccount(account.id))}
              >
                {t("remove")}
              </Button>
            </div>
          ))}
          {state?.models.length ? (
            <p className="text-ui-caption text-foreground-subtle">
              {state.models.map((model) => model.displayName).join(" · ")}
            </p>
          ) : null}
          {(failed || state?.errorCode) && (
            <p role="alert" className="break-words text-ui-caption text-destructive">
              {t("failed")}
              {state?.errorCode ? ` (${state.errorCode})` : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
