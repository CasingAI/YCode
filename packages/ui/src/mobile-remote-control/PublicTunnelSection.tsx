import { useEffect, useState } from "react";
import { Check, Copy, Globe, Loader2 } from "lucide-react";
import QRCode from "qrcode";
import {
  PUBLIC_TUNNEL_PROVIDERS,
  findPublicTunnelProvider,
  validatePublicTunnelParams,
  type PublicTunnelProviderId,
} from "@zcode/services";
import {
  TID_MOBILE_REMOTE_PUBLIC_CLOSE,
  TID_MOBILE_REMOTE_PUBLIC_COPY,
  TID_MOBILE_REMOTE_PUBLIC_CREATE,
  TID_MOBILE_REMOTE_PUBLIC_ERROR,
  TID_MOBILE_REMOTE_PUBLIC_PROVIDER,
  TID_MOBILE_REMOTE_PUBLIC_QR,
  TID_MOBILE_REMOTE_PUBLIC_SUBDOMAIN,
  TID_MOBILE_REMOTE_PUBLIC_URL,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { MobileRemoteControlView } from "@/hooks/useMobileRemoteControl.js";
import { writeTextToClipboard } from "@/lib/clipboard.js";

/** 默认 Provider：Cloudflare 临时隧道（免账号、免配置）。 */
const DEFAULT_PROVIDER: PublicTunnelProviderId = "cloudflare-quick";

/**
 * 「公网链接」区块。
 *
 * 纯展示 + 表单：状态全部来自 `view.status.public`（Host 的唯一事实来源），
 * 这里只负责收集 Provider 与子域名、调用 `createPublicUrl` / `closePublicUrl`。
 *
 * Provider 目录读的是服务层的 `PUBLIC_TUNNEL_PROVIDERS`，UI 不维护第二份清单；
 * 子域名的合法性也用服务层同一套校验，不在 UI 里另写一份正则。
 */
export function PublicTunnelSection({ view }: { view: MobileRemoteControlView }) {
  const { intl } = useZCodeIntl();
  const { status } = view;
  const publicStatus = status.public;
  const [provider, setProvider] = useState<PublicTunnelProviderId>(DEFAULT_PROVIDER);
  const [subdomain, setSubdomain] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const remoteRunning = status.state === "running";
  const creating = publicStatus?.state === "starting";
  const publicUrl = publicStatus?.state === "running" ? publicStatus.url : undefined;
  const descriptor = findPublicTunnelProvider(provider);
  const needsSubdomain = descriptor?.requiresSubdomain ?? false;

  useEffect(() => {
    if (!publicUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(publicUrl, { width: 440, margin: 2 }).then(
      (url) => {
        if (!cancelled) setQrDataUrl(url);
      },
      () => {
        // 二维码只是便捷形式，生成失败不影响链接本身可用。
        if (!cancelled) setQrDataUrl(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [publicUrl]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = () => {
    if (!publicUrl) return;
    void writeTextToClipboard(publicUrl).then(
      () => setCopied(true),
      (error: unknown) => {
        toast(
          intl.formatMessage(
            { id: "clipboard.copyFailed" },
            { error: error instanceof Error ? error.message : String(error) },
          ),
          { variant: "warning" },
        );
      },
    );
  };

  const handleCreate = () => {
    if (!remoteRunning) return;
    setFormError(null);
    const trimmed = subdomain.trim();
    // 缺项在本地先拦一道：不让用户白等一次隧道启动失败。
    // 校验规则来自服务层契约，Host 侧用的是同一份。
    if (needsSubdomain && trimmed && validatePublicTunnelParams({ provider, subdomain: trimmed })) {
      setFormError(intl.formatMessage({ id: "mobileRemote.public.error.invalidSubdomain" }));
      return;
    }
    void view.createPublicUrl({
      provider,
      ...(needsSubdomain && trimmed ? { subdomain: trimmed } : {}),
    });
  };

  // Host 侧的失败原因优先（它是真实原因）；本地缺项提示只在 Host 还没报过错时显示。
  const errorMessage =
    publicStatus?.state === "error" && publicStatus.error
      ? intl.formatMessage(
          { id: "mobileRemote.public.error.failed" },
          { detail: publicStatus.error },
        )
      : formError;

  return (
    <section className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-background-alt p-3">
      <div className="flex items-center gap-2">
        <Globe className="size-4 text-foreground-subtle" aria-hidden="true" />
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "mobileRemote.public.title" })}
        </h3>
      </div>
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "mobileRemote.public.description" })}
      </p>

      {errorMessage ? (
        <div
          data-testid={TID_MOBILE_REMOTE_PUBLIC_ERROR}
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base break-words whitespace-pre-wrap text-destructive"
        >
          {errorMessage}
        </div>
      ) : null}

      {publicUrl ? (
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border bg-surface px-3 py-2">
            {/* 链接带 token，横向滚动会把它截断；换行显示保证完整可见。 */}
            <code
              data-testid={TID_MOBILE_REMOTE_PUBLIC_URL}
              className="min-w-0 flex-1 text-ui-base break-all text-foreground"
            >
              {publicUrl}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid={TID_MOBILE_REMOTE_PUBLIC_COPY}
              aria-label={intl.formatMessage({ id: "mobileRemote.public.copy" })}
              onClick={handleCopy}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
          {qrDataUrl ? (
            <img
              data-testid={TID_MOBILE_REMOTE_PUBLIC_QR}
              src={qrDataUrl}
              alt={intl.formatMessage({ id: "mobileRemote.public.qrAlt" })}
              className="mx-auto aspect-square w-full max-w-[200px] shrink-0 rounded-lg bg-white p-2"
            />
          ) : null}
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "mobileRemote.public.sensitiveHint" })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            data-testid={TID_MOBILE_REMOTE_PUBLIC_CLOSE}
            disabled={view.pending}
            onClick={() => void view.closePublicUrl()}
          >
            {intl.formatMessage({ id: "mobileRemote.public.close" })}
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mobile-remote-public-provider">
              {intl.formatMessage({ id: "mobileRemote.public.providerLabel" })}
            </Label>
            <Select
              value={provider}
              onValueChange={(next) => {
                setProvider(next as PublicTunnelProviderId);
                setFormError(null);
              }}
              disabled={creating || view.pending}
            >
              <SelectTrigger
                id="mobile-remote-public-provider"
                data-testid={TID_MOBILE_REMOTE_PUBLIC_PROVIDER}
                variant="input"
                size="lg"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PUBLIC_TUNNEL_PROVIDERS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {intl.formatMessage({ id: `mobileRemote.public.provider.${item.id}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({
                id: `mobileRemote.public.providerHint.${provider}`,
              })}
            </p>
          </div>

          {needsSubdomain ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mobile-remote-public-subdomain">
                  {intl.formatMessage({ id: "mobileRemote.public.subdomainLabel" })}
                </Label>
                <Input
                  id="mobile-remote-public-subdomain"
                  data-testid={TID_MOBILE_REMOTE_PUBLIC_SUBDOMAIN}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  size="lg"
                  placeholder={intl.formatMessage({
                    id: "mobileRemote.public.subdomainPlaceholder",
                  })}
                  value={subdomain}
                  disabled={creating || view.pending}
                  onChange={(event) => {
                    setSubdomain(event.target.value);
                    setFormError(null);
                  }}
                />
              </div>
              <p className="text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: "mobileRemote.public.subdomainHint" })}
              </p>
            </div>
          ) : null}

          <Button
            type="button"
            variant="default"
            size="lg"
            className="w-full"
            data-testid={TID_MOBILE_REMOTE_PUBLIC_CREATE}
            disabled={!remoteRunning || creating || view.pending}
            onClick={handleCreate}
          >
            {creating ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({
              id: creating ? "mobileRemote.public.creating" : "mobileRemote.public.create",
            })}
          </Button>
          {remoteRunning ? null : (
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "mobileRemote.public.needsRunning" })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
