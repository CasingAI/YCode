import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoxIcon, ChevronDownIcon, ChevronRightIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSandboxConsole } from "@/hooks/useSandboxConsole.js";
import { useSandboxStatus } from "@/hooks/useSandboxStatus.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { shouldCoverSandboxConsoleAsDead } from "@/v4/conversationStatusPanelModel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { logger } from "@/logger.js";
import type { SandboxEvalResult } from "@zcode/shared/zcode-protocol-v4";
import type { SandboxConsoleSidePaneTab } from "@/lib/workspaceSidePane.js";

/**
 * 沙盒控制台 tab（阶段8可交互面）。
 * 像 Chrome DevTools：用户敲什么就 eval 什么（V4 sandboxEval 命令，不是一次
 * Sandbox 工具调用，不受工具必填说明 / return 协议约束），能看见这份实例的
 * 完整 console。用户输入仍进同一活实例，不写 transcript，不在聊天时间线留条。
 * 重置按钮销毁实例、LocalStorage 留下；在途 Sandbox 按失败结算，后台 ID 全失效。
 * 实例没了不自动关：整页覆盖挡住全部内容，只留关闭按钮（不提供重建）。
 */
export const SandboxConsoleSidePane = memo(function SandboxConsoleSidePane({
  tab,
  visible,
  onClose,
}: {
  tab: SandboxConsoleSidePaneTab;
  visible: boolean;
  onClose?: (tabId: string) => void;
}) {
  // eval 与重置要发 v4 命令，因此和 BackgroundBashOutputSidePane 一样自带
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
      <SandboxConsolePaneContent tab={tab} visible={visible} onClose={onClose} />
    </V4PaneConversationProvider>
  );
});

/**
 * 死亡覆盖层（阶段7/8）：实例没了不自动关 tab，整页覆盖挡住全部内容，只留关闭
 * 按钮（不提供重建）。独立导出方便点检单测直渲染断言：覆盖出现 + 标题/描述/
 * 关闭按钮三件齐全，且与输入框/重置按钮互斥（覆盖态下两者都不可达）。
 */
export function SandboxConsoleDeadOverlay({ onClose }: { onClose?: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-testid="sandbox-console-dead-overlay"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-panel px-6 text-center"
    >
      <BoxIcon aria-hidden className="size-8 text-foreground-subtlest" />
      <p className="text-ui-base text-foreground">
        {intl.formatMessage({ id: "sandboxConsole.dead.title" })}
      </p>
      <p className="max-w-80 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "sandboxConsole.dead.description" })}
      </p>
      <Button variant="outline" size="sm" data-testid="sandbox-console-close" onClick={onClose}>
        <XIcon aria-hidden className="size-3.5" />
        {intl.formatMessage({ id: "sandboxConsole.dead.close" })}
      </Button>
    </div>
  );
}

const SandboxConsolePaneContent = memo(function SandboxConsolePaneContent({
  tab,
  visible,
  onClose,
}: {
  tab: SandboxConsoleSidePaneTab;
  visible: boolean;
  onClose?: (tabId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { sendCommand } = useV4Conversation();
  const { snapshot, error, refresh } = useSandboxConsole(tab, visible);
  // 死亡覆盖的判定读 sandboxStatus（与状态面板分区同一查询，不靠快照失败猜）：
  // tab 可见时才轮询存在性，与快照轮询同门。首查未回前不盖，避免加载闪覆盖。
  const { alive: statusAlive, checked: statusChecked } = useSandboxStatus(tab, visible);
  const scroll = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [lastEval, setLastEval] = useState<SandboxEvalResult | null>(null);
  const [resetting, setResetting] = useState(false);
  // 超长执行行的只读全文展开（行内展开，只读展示，不可编辑；随快照轮询回流）。
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<number>>(new Set());

  const toggleRowExpanded = useCallback((seq: number) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    if (!visible || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [visible, snapshot?.lines.length, snapshot?.executions.length, lastEval]);

  useLayoutEffect(() => {
    setDraft("");
    setEvalError(null);
    setLastEval(null);
  }, [tab.sessionId, tab.workspacePath, tab.workspaceIdentity, tab.remoteSessionId]);

  const handleClose = useCallback(() => {
    onClose?.(tab.id);
  }, [onClose, tab.id]);

  const handleEval = useCallback(async () => {
    const code = draft.trim();
    if (!code || sending) return;
    setSending(true);
    setEvalError(null);
    try {
      const ack = await sendCommand(
        createCommandEnvelope({
          type: "sandboxEval",
          payload: { code },
          sessionId: tab.sessionId,
        }),
      );
      if (ack.status !== "accepted" || !ack.result || ack.result.type !== "sandboxEval") {
        // 命令被拒绝/失败：ACK 状态机语义（guard/fault），不是 eval 本身的失败。
        setEvalError(
          ack.reasonCode ?? (ack.status === "accepted" ? "sandboxConsole.eval.noResult" : ack.status),
        );
        return;
      }
      const result = ack.result.result;
      setLastEval(result);
      if (result.kind === "completed") {
        // 成功即清输入：执行行与 console 经轮询回流，不靠本地拼。
        setDraft("");
      } else {
        setEvalError(result.code ?? result.kind);
      }
    } catch (cause) {
      logger.debug("Sandbox eval command failed", { cause });
      setEvalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }, [draft, sendCommand, sending, tab.sessionId]);

  const handleReset = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    setEvalError(null);
    try {
      const ack = await sendCommand(
        createCommandEnvelope({
          type: "sandboxReset",
          payload: {},
          sessionId: tab.sessionId,
        }),
      );
      if (ack.status !== "accepted") {
        setEvalError(ack.reasonCode ?? ack.status);
        return;
      }
      // 重置后实例消失：存在性轮询会关掉分区并盖住本 tab；本地快照等待轮询回流。
      setLastEval(null);
      refresh();
    } catch (cause) {
      logger.debug("Sandbox reset command failed", { cause });
      setEvalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResetting(false);
    }
  }, [refresh, resetting, sendCommand, tab.sessionId]);

  // 死亡覆盖规则见 shouldCoverSandboxConsoleAsDead（抽纯方便单测钉死），此处只传参。
  const dead = shouldCoverSandboxConsoleAsDead({
    statusChecked,
    statusAlive,
    snapshotAlive: snapshot?.alive ?? null,
  });
  // unsupported / read_failed / query_failed 才是报错；存在性未覆盖时不把
  // 快照的 unavailable 单独报错（覆盖态已表达实例没了）。
  const queryError = error !== null && error !== "unavailable" && !dead ? error : null;

  return (
    <section
      data-testid="sandbox-console-details"
      data-session-id={tab.sessionId}
      data-alive={snapshot ? String(snapshot.alive) : "loading"}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-panel text-ui-base text-foreground-subtle"
    >
      {queryError ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 px-4 py-2 text-danger">
          <span>{intl.formatMessage({ id: `sandboxConsole.error.${queryError}` })}</span>
          <Button variant="ghost" size="sm" onClick={refresh}>
            {intl.formatMessage({ id: "sandboxConsole.retry" })}
          </Button>
        </div>
      ) : null}

      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <BoxIcon aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
        <p
          data-testid="sandbox-console-title"
          className="min-w-0 flex-1 truncate text-ui-base text-foreground"
        >
          {intl.formatMessage({ id: "sandboxConsole.title" })}
        </p>
        <Button
          variant="ghost"
          size="sm"
          data-testid="sandbox-console-reset"
          aria-label={intl.formatMessage({ id: "sandboxConsole.reset" })}
          title={intl.formatMessage({ id: "sandboxConsole.resetHint" })}
          onClick={handleReset}
          disabled={resetting || dead}
          className="h-6 shrink-0 px-1.5 text-ui-sm text-foreground-subtle"
        >
          <RotateCcwIcon aria-hidden className="size-3" />
          {intl.formatMessage({ id: "sandboxConsole.reset" })}
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        <ScrollFadeViewport
          ref={scroll}
          data-testid="sandbox-console-scroll"
          className="h-full overflow-auto px-4 py-3"
          tabIndex={0}
        >
          {snapshot === null && !queryError && !dead ? (
            <p
              data-testid="sandbox-console-loading"
              className="text-ui-base text-foreground-subtlest"
            >
              {intl.formatMessage({ id: "sandboxConsole.loading" })}
            </p>
          ) : null}
          {snapshot?.executions.length ? (
            <ul data-testid="sandbox-console-executions" className="mb-3 space-y-1.5">
              {snapshot.executions.map((row) => {
                const expanded = expandedRows.has(row.seq);
                return (
                  <li
                    key={row.seq}
                    data-testid="sandbox-console-execution"
                    data-source={row.source}
                    className="min-w-0 rounded-lg bg-surface px-2 py-1.5"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <span
                        data-testid="sandbox-console-execution-source"
                        data-source={row.source}
                        className={
                          row.source === "model"
                            ? "shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs text-foreground-subtle"
                            : "shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-ui-xs text-foreground"
                        }
                      >
                        {intl.formatMessage({
                          id:
                            row.source === "model"
                              ? "sandboxConsole.source.model"
                              : "sandboxConsole.source.user",
                        })}
                      </span>
                      {row.truncated ? (
                        <button
                          type="button"
                          data-testid="sandbox-console-execution-toggle"
                          aria-expanded={expanded}
                          aria-label={intl.formatMessage({
                            id: expanded
                              ? "sandboxConsole.execution.collapse"
                              : "sandboxConsole.execution.expand",
                          })}
                          onClick={() => toggleRowExpanded(row.seq)}
                          className="flex min-w-0 flex-1 items-start gap-1 text-left"
                        >
                          <span className="min-w-0 flex-1 break-words font-mono text-ui-sm text-foreground">
                            {expanded ? row.code : row.preview}
                          </span>
                          {expanded ? (
                            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
                          ) : (
                            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
                          )}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 break-words font-mono text-ui-sm text-foreground">
                          {row.preview}
                        </span>
                      )}
                    </div>
                    {expanded && row.truncated ? (
                      <pre
                        data-testid="sandbox-console-execution-full"
                        className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-panel px-2 py-1.5 font-mono text-ui-sm text-foreground"
                      >
                        {row.code}
                      </pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {snapshot?.lines.length ? (
            <pre
              data-testid="sandbox-console-output"
              className="whitespace-pre-wrap break-words font-mono text-ui-base leading-5"
            >
              {snapshot.lines.map((line) => line.text).join("\n")}
            </pre>
          ) : snapshot !== null && !dead ? (
            <p
              data-testid="sandbox-console-empty"
              className="font-mono text-ui-base leading-5 text-foreground-subtlest"
            >
              {intl.formatMessage({ id: "sandboxConsole.empty" })}
            </p>
          ) : null}
          {lastEval?.kind === "completed" &&
          (lastEval.returnText !== undefined || lastEval.console) ? (
            <div
              data-testid="sandbox-console-last-eval"
              className="mt-3 rounded-lg border border-border bg-surface px-2 py-1.5"
            >
              {lastEval.returnText !== undefined ? (
                <pre
                  data-testid="sandbox-console-last-return"
                  className="whitespace-pre-wrap break-words font-mono text-ui-base text-foreground"
                >
                  {lastEval.returnText}
                </pre>
              ) : null}
              {lastEval.console ? (
                <pre
                  data-testid="sandbox-console-last-console"
                  className="whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle"
                >
                  {lastEval.console}
                </pre>
              ) : null}
            </div>
          ) : null}
          {evalError ? (
            <p
              role="alert"
              data-testid="sandbox-console-eval-error"
              className="mt-3 break-words font-mono text-ui-sm text-danger"
            >
              {evalError}
            </p>
          ) : null}
        </ScrollFadeViewport>
      </div>

      {!dead ? (
        <footer className="flex shrink-0 items-end gap-2 border-t border-border px-4 py-2.5">
          <span aria-hidden className="select-none pb-2 font-mono text-ui-base text-foreground-subtlest">
            ❯
          </span>
          <textarea
            data-testid="sandbox-console-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleEval();
              }
            }}
            rows={2}
            placeholder={intl.formatMessage({ id: "sandboxConsole.inputPlaceholder" })}
            aria-label={intl.formatMessage({ id: "sandboxConsole.inputLabel" })}
            className="min-h-9 min-w-0 flex-1 resize-y rounded-lg border border-input-border bg-input px-2 py-1.5 font-mono text-mobile-input-safe text-foreground placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused focus:outline-none md:text-ui-base"
          />
          <Button
            variant="default"
            size="sm"
            data-testid="sandbox-console-run"
            disabled={draft.trim().length === 0 || sending}
            onClick={() => void handleEval()}
            className="h-9 shrink-0"
          >
            <PlayIcon aria-hidden className="size-3.5" />
            {intl.formatMessage({ id: sending ? "sandboxConsole.running" : "sandboxConsole.run" })}
          </Button>
        </footer>
      ) : null}

      {dead ? <SandboxConsoleDeadOverlay onClose={handleClose} /> : null}
    </section>
  );
});
