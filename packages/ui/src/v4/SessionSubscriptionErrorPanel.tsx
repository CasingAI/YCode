import { useCallback, useState } from "react";
import { MessageSquareOff, Unplug } from "lucide-react";
import {
  TID_V4_RETRY_SUBSCRIBE,
  TID_V4_SUBSCRIPTION_ERROR_DETAILS,
  TID_V4_SUBSCRIPTION_ERROR_PANEL,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";
import {
  resolveSessionSubscriptionErrorDisplay,
  type SessionSubscriptionErrorDisplay,
} from "@/v4/sessionSubscriptionError.js";

interface SessionSubscriptionErrorPanelProps {
  error: string;
  sessionId: string;
  workspacePath: string;
  onReconnect: () => void;
}

/**
 * 订阅失败的完整空态面板（store 无 snapshot 时）。
 *
 * 会话已结束时（fault.subscribe.sessionNotFound）不渲染「重新连接」：
 * 重试注定再失败一次，按钮只会制造第二张一模一样的红屏。
 */
export function SessionSubscriptionErrorPanel(props: SessionSubscriptionErrorPanelProps) {
  const display = resolveSessionSubscriptionErrorDisplay(props.error);
  return <SessionSubscriptionErrorView {...props} display={display} layout="panel" />;
}

/**
 * 订阅失败的紧凑横幅：store 仍持有本会话 snapshot、历史已按只读渲染时，
 * 展示在历史之后，直到订阅恢复。
 */
export function SessionSubscriptionErrorNotice(props: SessionSubscriptionErrorPanelProps) {
  const display = resolveSessionSubscriptionErrorDisplay(props.error);
  return <SessionSubscriptionErrorView {...props} display={display} layout="notice" />;
}

function SessionSubscriptionErrorView({
  error,
  sessionId,
  workspacePath,
  onReconnect,
  display,
  layout,
}: SessionSubscriptionErrorPanelProps & {
  display: SessionSubscriptionErrorDisplay;
  layout: "panel" | "notice";
}) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const noticeLayout = layout === "notice";

  const titleId =
    display.kind === "sessionEnded"
      ? "chat.error.sessionEnded.title"
      : "chat.error.connectionLost";
  const descriptionId =
    display.kind === "sessionEnded"
      ? "chat.error.sessionEnded.description"
      : "chat.error.connectionLost.description";
  const title = intl.formatMessage({ id: titleId });
  const Icon = display.kind === "sessionEnded" ? MessageSquareOff : Unplug;

  const handleOpenFeedback = useCallback(async () => {
    openFeedbackSubmit({
      title: title.slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: false,
      description: buildErrorFeedbackDescription({
        message: error,
        contextLines: [
          intl.formatMessage({ id: "feedback.submit.template.section.taskInfo" }),
          intl.formatMessage({ id: "feedback.submit.template.section.taskId" }, { id: sessionId }),
          intl.formatMessage(
            { id: "feedback.submit.template.section.taskWorkspace" },
            { path: workspacePath },
          ),
        ],
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
  }, [error, intl, openFeedbackSubmit, sessionId, title, workspacePath]);

  const detailsToggle = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={TID_V4_SUBSCRIPTION_ERROR_DETAILS}
      aria-expanded={detailsExpanded}
      onClick={() => setDetailsExpanded((expanded) => !expanded)}
    >
      {intl.formatMessage({
        id: detailsExpanded ? "chat.error.collapseDetails" : "chat.error.expandDetails",
      })}
    </Button>
  );

  const feedbackButton = (
    <Button type="button" variant="outline" size="sm" onClick={handleOpenFeedback}>
      {intl.formatMessage({ id: "chat.error.feedback" })}
    </Button>
  );

  const reconnectButton = display.retryable ? (
    <Button
      type="button"
      size="sm"
      data-testid={TID_V4_RETRY_SUBSCRIBE}
      onClick={onReconnect}
    >
      {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
    </Button>
  ) : null;

  // 原始英文错误只服务诊断：收进「查看详情」展开区，不当正文、不上整屏红色。
  const detailsBlock = detailsExpanded ? (
    <pre
      className={
        noticeLayout
          ? "max-h-40 basis-full overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ui-sm whitespace-pre-wrap text-foreground-subtle"
          : "max-h-40 max-w-full overflow-auto rounded-lg border border-border bg-surface px-3 py-2 text-left font-mono text-ui-sm whitespace-pre-wrap text-foreground-subtle"
      }
    >
      {error}
    </pre>
  ) : null;

  if (noticeLayout) {
    return (
      <div
        role="alert"
        data-testid={TID_V4_SUBSCRIPTION_ERROR_PANEL}
        data-subscription-error-kind={display.kind}
        className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {title}
        </span>
        {detailsToggle}
        {feedbackButton}
        {reconnectButton}
        {detailsBlock}
      </div>
    );
  }

  return (
    <div
      data-testid={TID_V4_SUBSCRIPTION_ERROR_PANEL}
      data-subscription-error-kind={display.kind}
      className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-ui-base"
    >
      <Icon aria-hidden="true" className="size-8 text-foreground-subtle" />
      <p className="font-medium text-foreground">{title}</p>
      <p className="max-w-md text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: descriptionId })}
      </p>
      {detailsBlock}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {detailsToggle}
        {feedbackButton}
        {reconnectButton}
      </div>
    </div>
  );
}
