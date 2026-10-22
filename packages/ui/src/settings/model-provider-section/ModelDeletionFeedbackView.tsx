import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelDeletionFeedbackEntry } from "./modelDeletionFeedback.js";

export function ModelDeletionFeedbackView({
  entries,
  onRetry,
  onDismiss,
}: {
  entries: readonly ModelDeletionFeedbackEntry[];
  onRetry: (key: string) => void;
  onDismiss: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (entries.length === 0) return null;

  const deleted = entries.filter((entry) => entry.state === "success").length;
  const pending = entries.filter((entry) => entry.state === "pending").length;
  const failures = entries.filter((entry) => entry.state === "failure");
  const summary = [
    intl.formatMessage({ id: "settings.modelProvider.modelDeleteSummary" }, { deleted }),
    ...(failures.length
      ? [
          intl.formatMessage(
            { id: "settings.modelProvider.modelDeleteSummaryFailure" },
            { failed: failures.length },
          ),
        ]
      : []),
    ...(pending
      ? [
          intl.formatMessage(
            { id: "settings.modelProvider.modelDeleteSummaryPending" },
            { pending },
          ),
        ]
      : []),
  ].join(" · ");

  return (
    <div
      data-testid="model-deletion-feedback"
      className="pointer-events-auto w-full max-w-lg self-end rounded-xl border border-border bg-toast/95 text-foreground shadow-lg backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        {pending ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        ) : failures.length ? (
          <CircleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden="true" />
        )}
        <span
          role={failures.length ? "alert" : "status"}
          className="min-w-0 flex-1 text-ui-sm font-medium [overflow-wrap:anywhere]"
        >
          {summary}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "common.close" })}
          disabled={pending > 0}
          onClick={onDismiss}
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {failures.length ? (
        <details className="group border-t border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-ui-sm text-foreground-subtle hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            {intl.formatMessage(
              { id: "settings.modelProvider.modelDeleteFailureDetails" },
              { failed: failures.length },
            )}
          </summary>
          {/* 连续失败也只展开一个有界列表，长模型 ID 和错误不能撑满详情视口。 */}
          <ul className="max-h-[min(40dvh,16rem)] space-y-2 overflow-y-auto overscroll-contain px-3 pb-3">
            {failures.map((entry) => (
              <li key={entry.key} className="flex min-w-0 items-start gap-3">
                <div className="min-w-0 flex-1 text-ui-sm [overflow-wrap:anywhere]">
                  <div className="font-mono">{entry.modelId}</div>
                  <div className="mt-0.5 whitespace-pre-wrap text-destructive">{entry.error}</div>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => onRetry(entry.key)}>
                  {intl.formatMessage({ id: "common.retry" })}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
