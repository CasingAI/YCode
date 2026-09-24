import { FileOutputIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { isSafeVisibleToolTitle } from "./visibleToolIdentity.js";

const TASK_OUTPUT_TOOL_ICON = <FileOutputIcon className="size-4 shrink-0 text-foreground-subtle" />;

function isFailedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "failed" || normalized === "lost";
}

function isStoppedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "cancelled" || normalized === "killed" || normalized === "stopped";
}

function readTaskOutputTaskId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const taskId = (input as Record<string, unknown>).task_id;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined;
}

export function TaskOutputToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const taskOutputDisplay = display?.kind === "task_output" ? display : undefined;
  const taskStatus = taskOutputDisplay?.taskStatus;
  const normalizedTaskStatus = taskStatus?.trim().toLowerCase();
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isExecutionFailed = toolCall.status === "failed";
  const isTaskFailed = isFailedTaskStatus(taskStatus);
  const showFailureStatus = !isDenied && !isStopped && (isExecutionFailed || isTaskFailed);
  const output = taskOutputDisplay?.output;
  const hasOutput = output !== undefined;

  let outcomeLabel: string | undefined;
  if (isExecutionFailed) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.failed" });
  } else if (isDenied) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.denied" });
  } else if (isStopped) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.stopped" });
  } else if (taskOutputDisplay?.retrievalStatus === "not_ready") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.running" });
  } else if (taskOutputDisplay?.retrievalStatus === "timeout") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.timeout" });
  } else if (isTaskFailed) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.taskFailed" });
  } else if (isStoppedTaskStatus(taskStatus)) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.taskStopped" });
  } else if (normalizedTaskStatus === "pending" || normalizedTaskStatus === "running") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.running" });
  } else if (normalizedTaskStatus && normalizedTaskStatus !== "completed") {
    outcomeLabel = taskStatus ?? normalizedTaskStatus;
  } else if (taskOutputDisplay?.retrievalStatus === "success") {
    // 类别标签只能说明这是 TaskOutput，不能替代 display 已确认的成功读取结果。
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.retrieved" });
  }
  const kindLabel = intl.formatMessage({
    id: context.isRunning ? "chat.toolCall.taskOutput.fetching" : "chat.toolCall.kind.taskOutput",
  });

  const taskId = readTaskOutputTaskId(toolCall.input);
  const linkedTitle = taskId ? context.agentTitleByIdentity?.get(taskId) : undefined;
  const primaryTitle = useMemo(() => {
    const title = linkedTitle ?? toolCall.title;
    const isGenericToolTitle = title?.trim() === toolCall.toolName?.trim();
    return isSafeVisibleToolTitle(title) && !isGenericToolTitle
      ? title.trim()
      : intl.formatMessage({ id: "chat.toolCall.kind.taskOutput" });
  }, [intl, linkedTitle, toolCall.title, toolCall.toolName]);
  const primaryText = useMemo(
    () => <code className="min-w-0 truncate font-mono">{primaryTitle}</code>,
    [primaryTitle],
  );
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <pre className="max-h-25 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-base text-foreground-subtle">
          {output}
        </pre>
        {taskOutputDisplay?.truncated === true ? (
          <p className="mt-3 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.taskOutput.truncated" })}
          </p>
        ) : null}
      </div>
    ),
    [intl, output, taskOutputDisplay?.truncated],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={TASK_OUTPUT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasOutput && (context.canToggle ?? true)}
        forceOpen={hasOutput && (context.forceOpen ?? false)}
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={outcomeLabel}
        showStatusLabel={outcomeLabel != null}
        statusTooltip={isExecutionFailed ? context.errorText : undefined}
        showFailureStatus={showFailureStatus}
        isRunning={context.isRunning}
        title={primaryTitle}
        renderContent={hasOutput ? renderContent : undefined}
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
