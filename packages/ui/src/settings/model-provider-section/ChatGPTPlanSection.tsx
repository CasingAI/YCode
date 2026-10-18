import { useEffect, useState } from "react";
import { CHATGPT_PLAN_USAGE_URL } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useChatGPTPlan } from "@/hooks/useChatGPTPlan.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CliProxyUpstreamProxySelect,
  type CliProxyUpstreamProxyMode,
} from "./CliProxyUpstreamProxySelect.js";

export function ChatGPTPlanSection({
  enabled,
  proxyMode,
  onProxyModeChange,
}: {
  enabled: boolean;
  proxyMode: CliProxyUpstreamProxyMode;
  onProxyModeChange: (mode: CliProxyUpstreamProxyMode) => void | Promise<void>;
}) {
  const { available, state, busy, failed, run } = useChatGPTPlan(enabled);
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [savingProxyMode, setSavingProxyMode] = useState(false);
  const [proxyModeSaveFailed, setProxyModeSaveFailed] = useState(false);
  const t = (key: string) => intl.formatMessage({ id: `settings.chatGPTPlan.${key}` });
  const describeError = (code?: string) => {
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
      return intl.formatMessage(
        { id: "settings.chatGPTPlan.error.oauthEndpoint" },
        { status: statusMatch[1]! },
      );
    }
    return t("failed");
  };
  const handleProxyModeChange = (mode: CliProxyUpstreamProxyMode) => {
    if (savingProxyMode || mode === proxyMode) return;
    setSavingProxyMode(true);
    setProxyModeSaveFailed(false);
    void Promise.resolve(onProxyModeChange(mode))
      .catch(() => setProxyModeSaveFailed(true))
      .finally(() => setSavingProxyMode(false));
  };
  useEffect(() => {
    if (state && !state.pending) setAuthorizationUrl(null);
  }, [state]);
  const login = (accountId?: string) => {
    setLoginStarting(true);
    void run(async (service) => {
      const result = await service.startLogin(accountId);
      setAuthorizationUrl(result.authorizeUrl);
      platform.openExternal(result.authorizeUrl);
    }).finally(() => setLoginStarting(false));
  };
  return (
    <section
      aria-label={t("providerLabel")}
      className="space-y-3 rounded-lg border border-border bg-card p-4 text-ui-base"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{t("providerLabel")}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => platform.openExternal(CHATGPT_PLAN_USAGE_URL)}
        >
          {t("manageUsage")}
        </Button>
      </div>
      <p className="text-foreground-subtle">{t(available ? "description" : "localOnly")}</p>
      <CliProxyUpstreamProxySelect
        target="chatgpt-plan"
        mode={proxyMode}
        saving={savingProxyMode}
        onModeChange={handleProxyModeChange}
      />
      {proxyModeSaveFailed ? (
        <p role="alert" className="text-ui-caption text-destructive">
          {t("proxyModeSaveFailed")}
        </p>
      ) : null}
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
          {(loginStarting || state?.pending) && (
            <div
              aria-live="polite"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-3"
            >
              <p className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
                {loginStarting ? t("starting") : t("awaitingAuthorization")}
              </p>
              {authorizationUrl ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => platform.openExternal(authorizationUrl)}
                >
                  {t("openAuthorizationPage")}
                </Button>
              ) : null}
            </div>
          )}
          {state?.accounts.map((account) => (
            <div
              key={account.id}
              className="flex flex-wrap items-center gap-2 border-t border-border pt-2"
            >
              <span className="min-w-0 flex-1 break-all">{account.label}</span>
              {account.errorCode && (
                <span role="alert" className="text-ui-caption text-destructive">
                  {describeError(account.errorCode)} ({account.errorCode})
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
              {describeError(state?.errorCode)}
              {state?.errorCode ? ` (${state.errorCode})` : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
