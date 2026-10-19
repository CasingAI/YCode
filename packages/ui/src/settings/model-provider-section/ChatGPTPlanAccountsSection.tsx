import { useEffect, useState } from "react";
import { CHATGPT_PLAN_USAGE_URL, type ChatGPTPlanState } from "@zcode/shared";
import { Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useChatGPTPlan } from "@/hooks/useChatGPTPlan.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ChatGPTPlanController = ReturnType<typeof useChatGPTPlan>;
type ChatGPTPlanIntlFormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 稳定错误码 → 可操作文案；UI 不直接展示原始错误对象。 */
export function describeChatGPTPlanError(formatMessage: ChatGPTPlanIntlFormatMessage) {
  const t = (key: string) => formatMessage({ id: `settings.chatGPTPlan.${key}` });
  return (code?: string) => {
    if (!code) return t("failed");
    if (code === "dns_resolution_failed") return t("error.dnsResolution");
    if (code === "connection_timeout") return t("error.timeout");
    if (code === "proxy_connection_failed") return t("error.proxyConnection");
    if (code === "proxy_configuration_invalid") return t("error.proxyConfiguration");
    if (code === "tls_certificate_failed") return t("error.tlsCertificate");
    if (code === "oauth_endpoint_response_invalid" || code === "oauth_protocol_error")
      return t("error.oauthResponse");
    if (code === "oauth_network_request_failed" || code === "network_request_failed")
      return t("error.network");
    if (code === "reauthentication_required") return t("error.reauthentication");
    const statusMatch = /^oauth_endpoint_http_(\d{3})$/.exec(code);
    if (statusMatch) {
      return formatMessage(
        { id: "settings.chatGPTPlan.error.oauthEndpoint" },
        { status: statusMatch[1]! },
      );
    }
    return t("failed");
  };
}

/**
 * ChatGPT Plan 统一供应商卡片的 statusSection（docs/specs/openai-chatgpt-plan-provider.md
 * 「详情接入统一供应商卡片」）。账户状态唯一来源是 Host OAuth owner 的安全投影，
 * 本区块只渲染投影与发出命令，不缓存第二份账户事实。
 */
export function ChatGPTPlanAccountsSection({ enabled }: { enabled: boolean }) {
  const { available, state, busy, failed, run } = useChatGPTPlan(enabled);
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const t = (key: string) => intl.formatMessage({ id: `settings.chatGPTPlan.${key}` });
  const describeError = describeChatGPTPlanError(intl.formatMessage);
  const login = (accountId?: string) => {
    setLoginStarting(true);
    void run(async (service) => {
      const result = await service.startLogin(accountId);
      setAuthorizationUrl(result.authorizeUrl);
      platform.openExternal(result.authorizeUrl);
    }).finally(() => setLoginStarting(false));
  };
  useEffect(() => {
    if (state && !state.pending) setAuthorizationUrl(null);
  }, [state]);

  return (
    <section
      aria-label={t("accountsTitle")}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">{t("accountsTitle")}</h4>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {busy || loginStarting ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
          {available ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => platform.openExternal(CHATGPT_PLAN_USAGE_URL)}
            >
              {t("manageUsage")}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-ui-sm text-foreground-subtle">
        {t(available ? "description" : "localOnly")}
      </p>

      {available ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || Boolean(state?.pending)}
              onClick={() => login()}
            >
              {t("continue")}
            </Button>
            {state?.pending ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run((s) => s.cancelLogin())}
              >
                {t("cancel")}
              </Button>
            ) : null}
          </div>
          {loginStarting || state?.pending ? (
            <div
              aria-live="polite"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-3"
            >
              <p className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
                {loginStarting ? t("starting") : t("awaitingAuthorization")}
              </p>
              {authorizationUrl ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => platform.openExternal(authorizationUrl)}
                >
                  {t("openAuthorizationPage")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {state?.accounts.map((account) => (
            <ChatGPTPlanAccountCard
              key={account.id}
              account={account}
              activeAccountId={state.activeAccountId}
              busy={busy}
              describeError={describeError}
              onLogin={login}
              onRun={run}
            />
          ))}
          {failed || state?.errorCode ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {describeError(state?.errorCode)}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 单个账户子卡片；导出供测试直接验证状态徽章与操作分组。 */
export function ChatGPTPlanAccountCard({
  account,
  activeAccountId,
  busy,
  describeError,
  onLogin,
  onRun,
}: {
  account: ChatGPTPlanState["accounts"][number];
  activeAccountId: ChatGPTPlanState["activeAccountId"];
  busy: boolean;
  describeError: (code?: string) => string;
  onLogin: (accountId?: string) => void;
  onRun: ChatGPTPlanController["run"];
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.chatGPTPlan.${key}` });
  const isActive = activeAccountId === account.id;
  const planReady = account.connected && account.sharing;
  return (
    <div className="rounded-lg bg-surface p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium text-foreground">
          {account.label}
        </span>
        {isActive && planReady ? (
          <Badge variant="secondary">{t("selected")}</Badge>
        ) : (
          <span className="text-ui-xs text-foreground-subtlest">
            {t(!account.connected ? "signedOut" : planReady ? "planEnabled" : "permissionRequired")}
          </span>
        )}
      </div>
      {account.errorCode ? (
        <p role="alert" className="mt-1 break-words text-ui-xs text-destructive">
          {describeError(account.errorCode)}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {!isActive ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !account.connected}
            onClick={() => void onRun((s) => s.selectAccount(account.id))}
          >
            {t("select")}
          </Button>
        ) : null}
        {planReady ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onLogin(account.id)}
          >
            {t("reconnect")}
          </Button>
        )}
        {account.connected ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void onRun((s) => s.logout(account.id))}
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
          onClick={() => void onRun((s) => s.deleteAccount(account.id))}
        >
          {t("remove")}
        </Button>
      </div>
    </div>
  );
}
