import { useEffect, useState } from "react";
import { CHATGPT_PLAN_USAGE_URL } from "@zcode/shared";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useChatGPTPlanController } from "./ChatGPTPlanStateProvider.js";

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
 * ChatGPT Plan 统一供应商卡片的状态区（docs/specs/openai-chatgpt-plan-provider.md
 * 「详情接入统一供应商卡片」）。只表达「是否在用 ChatGPT 套餐」与官方用量入口：
 * token-sharing 凭据读不到套餐剩余额度（见 spec「套餐额度能力边界」），
 * 因此这里不放额度数字，账户身份与账户操作在卡片底部的账户行。
 */
export function ChatGPTPlanAccountsSection() {
  const { available, state, busy, failed, run } = useChatGPTPlanController();
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

  const activeAccount = state?.accounts.find((account) => account.id === state.activeAccountId);
  const planEnabled = Boolean(activeAccount?.connected && activeAccount.sharing);
  const connected = Boolean(state?.accounts.some((account) => account.connected));

  return (
    <section aria-label={t("planTitle")} className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">{t("planTitle")}</h4>
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
        {t(
          !available
            ? "localOnly"
            : planEnabled
              ? "planEnabled"
              : connected
                ? "permissionRequired"
                : "description",
        )}
      </p>

      {available ? (
        <div className="mt-3 space-y-2">
          {!connected ? (
            <Button
              type="button"
              size="sm"
              disabled={busy || Boolean(state?.pending)}
              onClick={() => login()}
            >
              {t("continue")}
            </Button>
          ) : null}
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
