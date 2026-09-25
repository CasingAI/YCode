import { memo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";

interface PendingCommandRecoveryBannerProps {
  entry: PendingCommandEntry;
  onResend?: () => void;
  onReconcile?: () => void;
  onDismiss: () => void;
}

/** 恢复提示只把明确 discarded 的输入交给用户重发；unknown 只能重新对账。 */
export const PendingCommandRecoveryBanner = memo(function PendingCommandRecoveryBanner({
  entry,
  onResend,
  onReconcile,
  onDismiss,
}: PendingCommandRecoveryBannerProps) {
  const { intl } = useZCodeIntl();
  const hasReplayPayload = entry.replay.kind === "input";
  const unknown = entry.recovery?.kind === "unknown";
  // 根因：恢复提示过去用了整块 warning 黄色，和同一 bottom dock 的普通 error
  // 形成了错误的视觉层级。这里复用 ChatErrorBanner 的默认 surface/border/foreground。
  return (
    <div
      role="status"
      className="mb-3 flex w-full shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base text-foreground backdrop-blur-md"
    >
      <p className="min-w-0 flex-1">
        {intl.formatMessage({
          id: unknown ? "chat.pendingCommand.unknown" : "chat.pendingCommand.discarded",
        })}
      </p>
      {unknown && onReconcile ? (
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-foreground hover:bg-hover"
          onClick={onReconcile}
        >
          {intl.formatMessage({ id: "chat.pendingCommand.reconcile" })}
        </button>
      ) : null}
      {!unknown && hasReplayPayload && onResend ? (
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
          onClick={onResend}
        >
          {intl.formatMessage({ id: "chat.pendingCommand.resend" })}
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded-md px-2 py-1 text-foreground-subtle hover:bg-hover"
        onClick={onDismiss}
      >
        {intl.formatMessage({ id: "chat.pendingCommand.dismiss" })}
      </button>
    </div>
  );
});
