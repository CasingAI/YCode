import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { writeTextToClipboard } from "@/lib/clipboard.js";
import type { MobileRemoteControlView } from "@/hooks/useMobileRemoteControl.js";
import { PublicTunnelSection } from "@/mobile-remote-control/PublicTunnelSection.js";
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
    void writeTextToClipboard(accessUrl).then(
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

  const errorMessage = status.error
    ? status.errorCode === "web-root-missing"
      ? intl.formatMessage({ id: "mobileRemote.error.webRootMissing" })
      : intl.formatMessage({ id: "mobileRemote.error.startFailed" }, { detail: status.error })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_MOBILE_REMOTE_DIALOG}
        // 内容（二维码 + 链接 + 多网卡地址）高于视口时会被裁掉。
        // 这里限高，并分成「标题 / 可滚动内容 / 操作区」三行：
        // 中间行自己滚，标题与操作区始终留在原位，不会出现内容被腰斩、
        // 操作区压在内容上、按钮与说明文字互相错位的观感。
        className="max-h-[calc(100dvh-2rem)] w-[min(420px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
            <Smartphone className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "mobileRemote.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "mobileRemote.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
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
                {/* 链接带 token，横向滚动会把 token 截断成看不出全貌的一截；
                    这里换成换行显示，保证链接（含 token）完整可见。 */}
                <code className="min-w-0 flex-1 text-ui-base break-all text-foreground">
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

          {/* 公网链接区块：独立成块，不与局域网链接混在一起。
              它自己在需要远控 running 时才允许创建（按钮禁用并提示），所以未开启时也照常展示。 */}
          <PublicTunnelSection view={view} />
        </div>

        {/* 操作区：动作一行、后果说明一行。
            之前把「重置 Token」按钮、长说明和「开启/停止」挤在同一行 flex 里，
            说明文字只能占一条窄列、折成两三行，脚部既高又与按钮错位。
            现在按钮各自独占一行两端对齐，说明文字整行放在下面。 */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            {/* 重置 Token 是维护动作：只在用户开启过（有固定 token）时出现，
                重置会让旧链接立刻失效，因此下面给一句后果说明而不是静默换掉。 */}
            {status.enabled ? (
              <Button
                type="button"
                variant="ghost"
                size="lg"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                data-testid={TID_MOBILE_REMOTE_RESET_TOKEN}
                disabled={view.pending}
                onClick={() => void view.resetToken()}
              >
                {intl.formatMessage({ id: "mobileRemote.resetToken" })}
              </Button>
            ) : (
              <span />
            )}
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
          {status.enabled ? (
            <p className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "mobileRemote.resetTokenHint" })}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
