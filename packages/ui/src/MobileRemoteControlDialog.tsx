import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { MobileRemoteControlView } from "@/hooks/useMobileRemoteControl.js";
import {
  TID_MOBILE_REMOTE_COPY_URL,
  TID_MOBILE_REMOTE_DIALOG,
  TID_MOBILE_REMOTE_ERROR,
  TID_MOBILE_REMOTE_QR,
  TID_MOBILE_REMOTE_RESET_TOKEN,
  TID_MOBILE_REMOTE_START,
  TID_MOBILE_REMOTE_STOP,
} from "@zcode/shared";

/**
 * 远程控制弹窗。
 *
 * 纯展示：所有状态都来自 useMobileRemoteControl（也就是窗口 Host），
 * 弹窗自己不维护"已开启"之类的本地事实。
 */
export function MobileRemoteControlDialog({
  open,
  onOpenChange,
  view,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: MobileRemoteControlView;
  onStart: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { status } = view;
  const accessUrl = status.accessUrl;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!accessUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(accessUrl, { width: 440, margin: 2 }).then(
      (url) => {
        if (!cancelled) setQrDataUrl(url);
      },
      () => {
        // 二维码只是入口的便捷形式，生成失败不影响链接本身可用。
        if (!cancelled) setQrDataUrl(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accessUrl]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = () => {
    if (!accessUrl) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(accessUrl).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  const errorMessage = status.error
    ? status.errorCode === "web-root-missing"
      ? intl.formatMessage({ id: "mobileRemote.error.webRootMissing" })
      : intl.formatMessage({ id: "mobileRemote.error.startFailed" }, { detail: status.error })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_MOBILE_REMOTE_DIALOG}
        // DialogContent 默认不限高，内容（二维码 + 链接 + 多网卡地址）高于视口时会被上下裁掉。
        // 这里限高并让内容自己滚，保证关闭按钮与小屏上的开关始终可达。
        className="max-h-[calc(100dvh-2rem)] w-[min(420px,calc(100vw-2rem))] overflow-y-auto"
      >
        <DialogTitle className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
          <Smartphone className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "mobileRemote.title" })}
        </DialogTitle>
        <DialogDescription className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "mobileRemote.description" })}
        </DialogDescription>

        {errorMessage ? (
          <div
            data-testid={TID_MOBILE_REMOTE_ERROR}
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base break-words whitespace-pre-wrap text-destructive"
          >
            {errorMessage}
          </div>
        ) : null}

        {status.state === "running" && accessUrl ? (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border bg-surface px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto text-ui-base whitespace-nowrap text-foreground">
                {accessUrl}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid={TID_MOBILE_REMOTE_COPY_URL}
                aria-label={intl.formatMessage({ id: "mobileRemote.copy" })}
                onClick={handleCopy}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            {qrDataUrl ? (
              <img
                data-testid={TID_MOBILE_REMOTE_QR}
                src={qrDataUrl}
                alt={intl.formatMessage({ id: "mobileRemote.qrAlt" })}
                // 二维码随弹窗宽度收缩，窄窗口下不再撑破卡片；data URL 按 440px 生成，显示缩小后更清晰。
                className="mx-auto aspect-square w-full max-w-[200px] shrink-0 rounded-lg bg-white p-2"
              />
            ) : null}
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "mobileRemote.scanHint" })}
            </p>
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "mobileRemote.stableHint" })}
            </p>
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "mobileRemote.connectedDevices" },
                { count: status.connectedClients },
              )}
            </p>
            {status.lanUrls.length > 1 ? (
              <div className="text-ui-base text-foreground-subtle">
                <p>{intl.formatMessage({ id: "mobileRemote.otherAddresses" })}</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {status.lanUrls.map((url) => (
                    <li key={url} className="font-mono break-all">
                      {url}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {/* 重置 Token 是维护动作：只在用户开启过（有固定 token）时出现，
                重置会让旧链接立刻失效，因此旁边给一句后果说明而不是静默换掉。 */}
            {status.enabled ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  data-testid={TID_MOBILE_REMOTE_RESET_TOKEN}
                  disabled={view.pending}
                  onClick={() => void view.resetToken()}
                >
                  {intl.formatMessage({ id: "mobileRemote.resetToken" })}
                </Button>
                <span className="text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({ id: "mobileRemote.resetTokenHint" })}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status.state === "running" ? (
              <Button
                type="button"
                variant="outline"
                size="lg"
                data-testid={TID_MOBILE_REMOTE_STOP}
                disabled={view.pending}
                onClick={() => void view.stop()}
              >
                {intl.formatMessage({ id: "mobileRemote.stop" })}
              </Button>
            ) : (
              <Button
                type="button"
                variant="default"
                size="lg"
                data-testid={TID_MOBILE_REMOTE_START}
                disabled={view.pending || status.state === "starting"}
                onClick={onStart}
              >
                {status.state === "starting" || view.pending ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
                ) : null}
                {intl.formatMessage({
                  id: status.state === "error" ? "mobileRemote.retry" : "mobileRemote.start",
                })}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
