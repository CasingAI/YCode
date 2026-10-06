import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleXIcon,
  ClockIcon,
  CopyIcon,
  LoaderCircleIcon,
  SquareIcon,
} from "lucide-react";
import { BACKGROUND_BASH_OUTPUT_MAX_BYTES } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBackgroundBashOutput } from "@/hooks/useBackgroundBashOutput.js";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { useLiveDurationSeconds } from "@/hooks/useLiveDurationSeconds.js";
import { logger } from "@/logger.js";
import type { BackgroundBashSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import {
  backgroundBashElapsedMs,
  backgroundBashOutputView,
  formatBackgroundBashBytes,
  type BackgroundBashViewStatus,
} from "./backgroundBashOutputView.js";

export const BackgroundBashOutputSidePane = memo(function BackgroundBashOutputSidePane({
  tab,
  visible,
  onOpenCodeViewer,
}: {
  tab: BackgroundBashSidePaneTab;
  visible: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  // 停止按钮要发 v4 cancelBackgroundWork，因此和 WorkflowRunSidePane 一样自带
  // 一个 pane 级会话 provider；scope 完全取自 tab，不另建身份。
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <BackgroundBashOutputPaneContent
        tab={tab}
        visible={visible}
        onOpenCodeViewer={onOpenCodeViewer}
      />
    </V4PaneConversationProvider>
  );
});

const BackgroundBashOutputPaneContent = memo(function BackgroundBashOutputPaneContent({
  tab,
  visible,
  onOpenCodeViewer,
}: {
  tab: BackgroundBashSidePaneTab;
  visible: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const { sendCommand } = useV4Conversation();
  const preview = useBackgroundBashOutput(tab, visible);
  const { latest, display, following } = preview;
  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  const view = useMemo(
    () => backgroundBashOutputView({ latest, fallbackTitle: tab.title, now: Date.now() }),
    [latest, tab.title],
  );

  // 终态用时必须定格：Stop 先标 cancelled、结算稍后才完成，这个窗口里没有
  // completedAt，若让秒表继续爬会在任务早已结束后越显示越大。
  const terminalElapsedMs = useRef<number | undefined>(undefined);
  if (view.status === "running" || view.status === "loading") {
    terminalElapsedMs.current = undefined;
  } else {
    terminalElapsedMs.current ??= view.elapsedMs;
  }
  const elapsedSeconds = useLiveDurationSeconds({
    running: view.status === "running",
    startedAt: latest?.startedAt,
    durationMs: terminalElapsedMs.current,
  });
  const elapsedLabel =
    elapsedSeconds === undefined
      ? undefined
      : formatBackgroundTaskElapsedLabel(elapsedSeconds * 1000, intl.formatMessage);

  useLayoutEffect(() => {
    if (!visible || !following || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
    previousTop.current = scroll.current.scrollTop;
  }, [visible, following, display?.output]);

  const handleStop = useCallback(() => {
    // 取消只有一条路径：既有的 v4 cancelBackgroundWork，与状态面板那一行同源。
    try {
      void sendCommand(
        createCommandEnvelope({
          type: "cancelBackgroundWork",
          payload: { workId: tab.workId },
          sessionId: tab.sessionId,
        }),
      ).catch((cause: unknown) => {
        logger.debug("Background Bash cancel failed", { workId: tab.workId, cause });
      });
    } catch (cause) {
      logger.debug("Background Bash cancel rejected", { workId: tab.workId, cause });
    }
  }, [sendCommand, tab.sessionId, tab.workId]);

  const statusLabel = backgroundBashStatusLabel(view.status, intl.formatMessage);
  const bytesLabel =
    view.stdoutBytes === undefined
      ? undefined
      : intl.formatMessage(
          { id: "bashOutput.bytes" },
          { size: formatBackgroundBashBytes(view.stdoutBytes, locale) },
        );
  const emptyLabel =
    view.status === "loading"
      ? intl.formatMessage({ id: "bashOutput.loading" })
      : view.status === "running"
        ? intl.formatMessage({ id: "bashOutput.waitingOutput" })
        : intl.formatMessage({ id: "bashOutput.noOutput" });

  return (
    <section
      data-testid="background-bash-details"
      data-work-id={tab.workId}
      data-status={latest?.status ?? "loading"}
      data-following={following}
      className="flex h-full min-h-0 min-w-0 flex-col bg-panel text-ui-base text-foreground-subtle"
    >
      {preview.error ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 px-4 py-2 text-danger">
          <span>{intl.formatMessage({ id: `bashOutput.error.${preview.error}` })}</span>
          <Button variant="ghost" size="sm" onClick={preview.refresh}>
            {intl.formatMessage({ id: "bashOutput.retry" })}
          </Button>
        </div>
      ) : null}

      {/* 命令头：面板既然挂了终端图标和终端标题，第一眼就该是命令本身，而不是空白。 */}
      <header className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          <span aria-hidden className="select-none font-mono text-ui-base text-foreground-subtlest">
            ❯
          </span>
          <p
            data-testid="background-bash-command"
            className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-ui-base text-foreground"
          >
            {view.command}
          </p>
          <CopyCommandButton text={view.command} />
        </div>
        {view.cwd ? (
          <p
            data-testid="background-bash-cwd"
            className="min-w-0 truncate pl-5 font-mono text-ui-sm text-foreground-subtlest"
            title={view.cwd}
          >
            {view.cwd}
          </p>
        ) : null}
      </header>

      <div
        data-testid="background-bash-statusbar"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-ui-sm"
      >
        <span
          role="status"
          data-testid="background-bash-running"
          data-view-status={view.status}
          className="flex shrink-0 items-center gap-2"
        >
          <BackgroundBashStatusIcon status={view.status} />
          {statusLabel}
        </span>
        {elapsedLabel ? <span className="tabular-nums">{elapsedLabel}</span> : null}
        {bytesLabel ? (
          <span className="tabular-nums" data-testid="background-bash-bytes">
            {bytesLabel}
          </span>
        ) : null}
        {view.exitCode !== undefined ? (
          <span className="tabular-nums" data-testid="background-bash-exit-code">
            {intl.formatMessage({ id: "bashOutput.exitCode" }, { code: view.exitCode })}
          </span>
        ) : null}
        {view.canStop ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="background-bash-stop"
            aria-label={intl.formatMessage({ id: "chat.summaryPanel.stopRunningBackgroundTask" })}
            onClick={handleStop}
            className="h-6 shrink-0 px-1.5 text-ui-sm text-foreground"
          >
            <SquareIcon aria-hidden className="size-3 fill-current" />
            {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
          </Button>
        ) : null}
        {latest && onOpenCodeViewer ? (
          <Button
            variant="link"
            size="xs"
            className="ml-auto h-auto px-0 text-ui-sm text-foreground-subtle"
            title={latest.outputPath}
            data-testid="background-bash-file"
            onClick={() =>
              onOpenCodeViewer({
                type: "file",
                path: latest.outputPath,
                title: latest.outputPath.split(/[\\/]/).pop() ?? latest.outputPath,
                workspacePath: tab.workspacePath,
                workspaceIdentity: tab.workspaceIdentity,
                workspaceRemoteSessionId: tab.remoteSessionId,
              })
            }
          >
            {intl.formatMessage({ id: "bashOutput.fullFile" })}
          </Button>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        <ScrollFadeViewport
          ref={scroll}
          data-testid="background-bash-scroll"
          className="h-full overflow-auto px-4 py-3"
          tabIndex={0}
          onScroll={(event) => {
            if (!visible) return;
            const el = event.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
            if (following && el.scrollTop < previousTop.current && !atBottom) {
              preview.pause();
              logger.debug("Background Bash output following changed", {
                workId: tab.workId,
                following: false,
              });
            } else if (!following && atBottom) {
              // 手动滚到底部也要恢复查询跟随，否则已到底时悬浮箭头仍会常驻。
              preview.resume();
              logger.debug("Background Bash output following changed", {
                workId: tab.workId,
                following: true,
              });
            }
            previousTop.current = el.scrollTop;
          }}
        >
          {view.truncated ? (
            <p
              data-testid="background-bash-truncated"
              className="mb-2 border-l-2 border-border pl-2 font-sans text-ui-sm text-foreground-subtlest"
            >
              {intl.formatMessage(
                { id: "bashOutput.truncated" },
                { size: formatBackgroundBashBytes(BACKGROUND_BASH_OUTPUT_MAX_BYTES, locale) },
              )}
            </p>
          ) : null}
          {view.hasOutput ? (
            <pre
              data-testid="background-bash-output"
              className="whitespace-pre-wrap break-words font-mono text-ui-base leading-5"
            >
              {display?.output}
            </pre>
          ) : (
            <p
              data-testid="background-bash-empty"
              className="font-mono text-ui-base leading-5 text-foreground-subtlest"
            >
              {emptyLabel}
            </p>
          )}
        </ScrollFadeViewport>
        {!following ? (
          <Button
            variant="outline"
            size="icon"
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-sm hover:bg-card-selected"
            data-testid="background-bash-resume"
            aria-label={intl.formatMessage({ id: "chat.scrollToBottom" })}
            title={intl.formatMessage({ id: "chat.scrollToBottom" })}
            onClick={preview.resume}
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </section>
  );
});

function BackgroundBashStatusIcon({ status }: { status: BackgroundBashViewStatus }) {
  if (status === "running") {
    return <LoaderCircleIcon aria-hidden className="size-3 animate-spin text-foreground" />;
  }
  if (status === "completed") {
    return <CheckCircle2Icon aria-hidden className="size-3 text-success" />;
  }
  if (status === "failed" || status === "spawn_error") {
    return <CircleXIcon aria-hidden className="size-3 text-danger" />;
  }
  if (status === "timed_out") {
    return <ClockIcon aria-hidden className="size-3 text-foreground" />;
  }
  if (status === "cancelled") {
    return <SquareIcon aria-hidden className="size-2.5 fill-current text-foreground" />;
  }
  return <LoaderCircleIcon aria-hidden className="size-3 animate-spin text-foreground-subtlest" />;
}

function backgroundBashStatusLabel(
  status: BackgroundBashViewStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status) {
    case "running":
      return formatMessage({ id: "bashOutput.status.running" });
    case "completed":
      return formatMessage({ id: "bashOutput.status.completed" });
    case "failed":
      return formatMessage({ id: "bashOutput.status.failed" });
    case "timed_out":
      return formatMessage({ id: "bashOutput.status.timed_out" });
    case "cancelled":
      return formatMessage({ id: "bashOutput.status.cancelled" });
    case "spawn_error":
      return formatMessage({ id: "bashOutput.status.spawn_error" });
    default:
      return formatMessage({ id: "bashOutput.loading" });
  }
}

function CopyCommandButton({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (text.length === 0) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-testid="background-bash-copy"
      aria-label={intl.formatMessage({
        id: copied ? "chat.toolCall.copyError.copied" : "chat.toolCall.copyError",
      })}
      title={intl.formatMessage({
        id: copied ? "chat.toolCall.copyError.copied" : "chat.toolCall.copyError",
      })}
      onClick={copy}
      className="size-6 shrink-0 text-foreground-subtle"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </Button>
  );
}
