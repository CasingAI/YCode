import { SendIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { isSafeVisibleToolTitle } from "./visibleToolIdentity.js";

const SEND_MESSAGE_TOOL_ICON = <SendIcon className="size-4 shrink-0 text-foreground-subtle" />;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readRawRecord(raw: unknown, keys: readonly string[]) {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = toRecord(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// SendMessage kind 三档：参数仍在流式（pending）→ 打字中；参数已完整、执行中
// （in_progress）或已正常结束（completed）→ 已发送；其余回落「发消息」。
// 失败态在外层先短路，沿用旧的两档行为（isRunning→打字中，否则发消息）。
function resolveSendMessageKindLabelId(
  isRunning: boolean,
  status: string,
  hasFailure: boolean,
): string {
  if (hasFailure) {
    return isRunning ? "chat.toolCall.sendMessage.sending" : "chat.toolCall.kind.sendMessage";
  }
  if (status === "pending") {
    return "chat.toolCall.sendMessage.sending";
  }
  if (status === "in_progress" || status === "completed") {
    return "chat.toolCall.sendMessage.sent";
  }
  return "chat.toolCall.kind.sendMessage";
}

function readRawResultContent(raw: unknown): unknown {
  const rawRecord = toRecord(raw);
  const result = toRecord(rawRecord?.result);
  return result?.content;
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-ui-base font-medium text-foreground-subtle">{label}</dt>
      <dd
        className={
          mono
            ? "whitespace-pre-wrap break-words font-mono text-ui-base text-foreground"
            : "whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

export function SendMessageToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const messageDisplay = display?.kind === "local_agent_message" ? display : undefined;
  const input = toRecord(toolCall.input) ?? readRawRecord(toolCall.raw, ["rawInput", "input"]);
  const directOutput = toRecord(toolCall.output);
  const rawResultContent = readRawResultContent(toolCall.raw);
  const rawResultOutput = toRecord(rawResultContent);
  const output =
    directOutput ?? readRawRecord(toolCall.raw, ["rawOutput", "output"]) ?? rawResultOutput;
  const outputText =
    (directOutput ? undefined : readText(toolCall.output)) ??
    (rawResultOutput ? undefined : readText(rawResultContent));
  const summary = readStringField(input, ["summary"]);
  const target = readStringField(input, ["to"]);
  const message = readStringField(input, ["message"]);
  const targetTitle = target ? context.agentTitleByIdentity?.get(target) : undefined;
  const visibleTargetTitle = target
    ? isSafeVisibleToolTitle(targetTitle)
      ? targetTitle.trim()
      : intl.formatMessage({ id: "chat.toolCall.sendMessage.targetFallback" })
    : undefined;
  // 折叠行收件人落点：可展示标题 > 可展示的原始 `to` > 本地化 fallback，恒有值且永不外露内部 ID。
  // 原因：`to` 在 input schema 里是必填的 agent_<uuid> 形态，与缺失标题一样不可直接展示（已有测试禁止原文出现内部 ID）；
  // 只有人工可读的 `to` 才允许直接作为「给 XXX」落点。展开态详情区继续沿用上面的 visibleTargetTitle，保持不变。
  const collapsedTargetTitle =
    visibleTargetTitle ??
    (isSafeVisibleToolTitle(target) ? target.trim() : undefined) ??
    intl.formatMessage({ id: "chat.toolCall.sendMessage.targetFallback" });
  const primaryTitle =
    [summary, toolCall.title].find(isSafeVisibleToolTitle)?.trim() ?? "SendMessage";
  // streaming input 首帧可能还没有字段，不能为一个空详情面板提供展开入口。
  const hasDetails = Boolean(target || summary || message);
  const outputMessage = readStringField(output, ["message"]);
  const outputError = readStringField(output, ["error"]);
  const outputStatus = readStringField(output, ["status"]);
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isCancelled =
    !isDenied &&
    !isStopped &&
    (toolCall.status === "cancelled" ||
      messageDisplay?.status === "cancelled" ||
      outputStatus === "cancelled");
  const isFailed =
    !isDenied &&
    !isStopped &&
    !isCancelled &&
    (toolCall.status === "failed" ||
      messageDisplay?.status === "failed" ||
      outputStatus === "failed");
  const failureMessage =
    isFailed || isCancelled
      ? (context.errorText ??
        messageDisplay?.error ??
        messageDisplay?.message ??
        outputError ??
        outputMessage ??
        outputText)
      : undefined;
  const visibleFailureMessage =
    target && failureMessage
      ? failureMessage.replaceAll(target, visibleTargetTitle ?? target)
      : failureMessage;
  // kind 三档：流式中（pending）→「打字发消息中」；参数已完整、工具执行中（in_progress）
  // 或已正常结束（completed）→「已发送」。失败态保持现状不动。
  // 原因：inputStreaming→running 的翻转发生在 ToolCallStarted（模型写完参数、权限通过、
  // handler 启动前，见 call-runner.ts 的 emitToolCallStarted），此后消息已交出，
  // 结束不改变「已发送」这个事实。叫醒已结束子代理时 running 阶段很长，旧的两档文案会长期误导。
  const kindLabelId = resolveSendMessageKindLabelId(
    context.isRunning,
    toolCall.status,
    isFailed || isCancelled || isDenied || isStopped,
  );
  const statusLabelId = isFailed
    ? "chat.toolCall.status.failed"
    : isCancelled
      ? "chat.toolCall.status.stopped"
      : isDenied
        ? "chat.toolCall.status.denied"
        : isStopped
          ? "chat.toolCall.status.stopped"
          : undefined;
  // 折叠态恒为「发消息 给 <收件人>」，任何情况都不占位显示摘要/正文（无收件人时收件人落点为本地化 fallback）。
  // 原因：折叠行同时堆摘要和收件人时信息过载，收件人才是路由关键；摘要与正文只在展开头与详情区出现。
  const expandedPrimaryText = useMemo(
    () => <span className="min-w-0 truncate">{primaryTitle}</span>,
    [primaryTitle],
  );
  const secondaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="shrink-0">
          {intl.formatMessage({ id: "chat.toolCall.sendMessage.to" })}
        </span>
        <span className="min-w-0 truncate">{collapsedTargetTitle}</span>
      </span>
    ),
    [intl, collapsedTargetTitle],
  );
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <dl className="space-y-3">
          {visibleTargetTitle ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.sendMessage.target" })}
              value={visibleTargetTitle}
            />
          ) : null}
          {summary ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.sendMessage.summary" })}
              value={summary}
            />
          ) : null}
          {message ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.sendMessage.message" })}
              value={message}
            />
          ) : null}
        </dl>
      </div>
    ),
    [intl, message, summary, visibleTargetTitle],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEND_MESSAGE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={undefined}
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={secondaryText}
        statusLabel={statusLabelId ? intl.formatMessage({ id: statusLabelId }) : undefined}
        showStatusLabel={statusLabelId != null}
        statusTooltip={isFailed || isCancelled ? visibleFailureMessage : undefined}
        showFailureStatus={isFailed || isCancelled}
        isRunning={context.isRunning}
        title={collapsedTargetTitle}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
