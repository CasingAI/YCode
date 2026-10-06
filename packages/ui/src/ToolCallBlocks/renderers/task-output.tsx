import { FileOutputIcon, TerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { DurationLabel } from "@/ToolCallBlocks/ToolSummarySegments.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { useRemainingWaitMs } from "@/hooks/useRemainingWaitMs.js";
import { formatDurationUnits } from "@/v4/conversationDurationDisplay.js";
import { isSafeVisibleToolTitle } from "./visibleToolIdentity.js";

const TASK_OUTPUT_TOOL_ICON = <FileOutputIcon className="size-4 shrink-0 text-foreground-subtle" />;

/** 子代理任务的 id 前缀：这类任务不是 Bash 后台任务，预览侧面板对它无效。 */
const SUBAGENT_TASK_ID_PREFIX = "agent_";

function isFailedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "failed" || normalized === "lost";
}

function isStoppedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "cancelled" || normalized === "killed" || normalized === "stopped";
}

function readToolInputRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function readTaskOutputTaskId(input: unknown): string | undefined {
  const taskId = readToolInputRecord(input)?.task_id;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined;
}

/**
 * 本次调用的等待预算。只认「确实要等」且「预算拿得到」的情况：
 * `block=false` 立即返回、根本不等待，显示预算会误导；`timeout` 读不到时不回落到契约
 * 默认值，那会显示一个并非本次真实调用的数字。参数流式解析阶段 input 还是半截，
 * 这里返回 undefined，走「不渲染」而不是显示错值。
 *
 * `block` 同时接受字符串 `"true"` / `"false"`，与契约 `semanticBoolean` 的预处理对齐。
 */
function readTaskOutputWaitBudgetMs(input: unknown): number | undefined {
  const record = readToolInputRecord(input);
  if (!record) return undefined;
  const block = record.block;
  if (block !== true && block !== "true") return undefined;
  const timeout = record.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) return undefined;
  return timeout;
}

export function TaskOutputToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl, locale } = useZCodeIntl();
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
    outcomeLabel = intl.formatMessage({
      id: "chat.toolCall.taskOutput.running",
    });
  } else if (taskOutputDisplay?.retrievalStatus === "timeout") {
    outcomeLabel = intl.formatMessage({
      id: "chat.toolCall.taskOutput.timeout",
    });
  } else if (isTaskFailed) {
    outcomeLabel = intl.formatMessage({
      id: "chat.toolCall.taskOutput.taskFailed",
    });
  } else if (isStoppedTaskStatus(taskStatus)) {
    outcomeLabel = intl.formatMessage({
      id: "chat.toolCall.taskOutput.taskStopped",
    });
  } else if (normalizedTaskStatus === "pending" || normalizedTaskStatus === "running") {
    outcomeLabel = intl.formatMessage({
      id: "chat.toolCall.taskOutput.running",
    });
  } else if (normalizedTaskStatus && normalizedTaskStatus !== "completed") {
    outcomeLabel = taskStatus ?? normalizedTaskStatus;
  } else if (taskOutputDisplay?.retrievalStatus === "success") {
    // 类别标签只能说明这是 TaskOutput，不能替代 display 已确认的成功读取结果。
    outcomeLabel = intl.formatMessage({
      id: "chat.toolCall.taskOutput.retrieved",
    });
  }
  const kindLabel = intl.formatMessage({
    id: context.isRunning ? "chat.toolCall.taskOutput.fetching" : "chat.toolCall.kind.taskOutput",
  });

  const taskId = readTaskOutputTaskId(toolCall.input);
  const linkedTitle = taskId ? context.agentTitleByIdentity?.get(taskId) : undefined;
  const primaryTitle = useMemo(() => {
    // 旧链路只消费 Agent 标题；display.title 让 Bash/Workflow 也能复用 runtime 任务描述。
    const title = [linkedTitle, taskOutputDisplay?.title, toolCall.title].find(
      (candidate) =>
        isSafeVisibleToolTitle(candidate) && candidate?.trim() !== toolCall.toolName?.trim(),
    );
    return title ? title.trim() : intl.formatMessage({ id: "chat.toolCall.kind.taskOutput" });
  }, [intl, linkedTitle, taskOutputDisplay?.title, toolCall.title, toolCall.toolName]);
  const primaryText = useMemo(
    () => <code className="min-w-0 truncate font-mono">{primaryTitle}</code>,
    [primaryTitle],
  );
  // 后台任务预览入口。展开区里的内联 output 是被裁剪过的快照，真实全量输出、跟随尾部、
  // Stop 都在侧面板里。`agent_` 是子代理任务而非 Bash 后台任务，侧面板查询端必然返回
  // unavailable，所以不提供注定失败的入口。
  const previewTarget = useMemo(() => {
    if (!context.onOpenBackgroundBash || !taskId || taskId.startsWith(SUBAGENT_TASK_ID_PREFIX)) {
      return undefined;
    }
    return {
      openPreview: () => context.onOpenBackgroundBash?.({ workId: taskId, title: primaryTitle }),
      label: intl.formatMessage({ id: "bashOutput.open" }, { title: primaryTitle }),
    };
  }, [context, intl, primaryTitle, taskId]);
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        {previewTarget ? (
          <button
            type="button"
            className="mb-3 inline-flex items-center gap-1.5 text-ui-xs text-foreground-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            aria-label={previewTarget.label}
            data-testid="task-output-open-preview"
            onClick={previewTarget.openPreview}
          >
            <TerminalIcon className="size-3.5 shrink-0" aria-hidden />
            {intl.formatMessage({ id: "chat.toolCall.taskOutput.openPreview" })}
          </button>
        ) : null}
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
    [intl, output, previewTarget, taskOutputDisplay?.truncated],
  );

  // 等待预算：只在运行中倒计时。终态不再显示时长——行上的 durationMs 是
  // ToolCallResult 事件时间戳减 ToolCallStarted，把读输出文件与结果序列化都算进去了，
  // 拿它当「等了多久」会把 2 分钟预算显示成「已等待 2 分 1 秒」。预算读不到
  // （block=false、参数仍在流式解析、被 snapshot 裁剪）时不渲染，也不用契约默认值兜底。
  const waitBudgetMs = context.isOfficeMode
    ? undefined
    : readTaskOutputWaitBudgetMs(toolCall.input);
  const remainingWaitMs = useRemainingWaitMs({
    running: context.isRunning,
    startedAt: toolCall.startedAt,
    budgetMs: waitBudgetMs,
  });
  const waitLabel = useMemo(() => {
    if (remainingWaitMs === undefined) return undefined;
    // 只向上取整，不再钳最小 1 秒：预算耗尽时剩余就是 0 秒，钳位会把它说成还剩 1 秒。
    // ceil 本身已覆盖另一半边界——剩 1 毫秒时也显示「1 秒」。
    const seconds = Math.ceil(remainingWaitMs / 1000);
    return intl.formatMessage(
      { id: "chat.toolCall.taskOutput.remainingWait" },
      { duration: formatDurationUnits(intl, { seconds, locale }) },
    );
  }, [intl, locale, remainingWaitMs]);

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
        durationLabel={waitLabel === undefined ? undefined : <DurationLabel label={waitLabel} />}
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
