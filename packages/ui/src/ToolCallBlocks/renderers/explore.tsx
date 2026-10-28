/* eslint-disable max-lines -- Explore 聚合渲染同时维护分类、父级摘要和可复用子工具摘要，拆开会让父子展示规则更难对齐 */
import { SearchIcon } from "lucide-react";
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";
import { buildReadSummary, ReadFileChip } from "@/ToolCallBlocks/renderers/read.js";
import { renderFilePath } from "@/ToolCallBlocks/shared.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  classifyToolCallActivity,
  getToolCallActivityTarget,
  isToolCallActivityRunning,
  type ToolCallActivity,
} from "@/lib/toolCallActivity.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { useCallback, type ReactNode } from "react";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ZCodePlanStep } from "@zcode/shared";

const EXPLORE_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

type ExploreChildSummary = {
  animationKey: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  title?: string;
};

type ExploreBucket = Exclude<ToolCallActivity, "unknown">;
const EXPLORE_BUCKETS: readonly ExploreBucket[] = [
  "file-search",
  "file-find",
  "directory-list",
  "file-read",
  "web-search",
  "web-read",
];

function getBucketLabel(intl: IntlLike, bucket: ExploreBucket, count: number) {
  return intl.formatMessage({
    id: `chat.toolCall.explore.bucket.${bucket}.${count === 1 ? "one" : "other"}`,
  });
}

function formatExploreSummary(intl: IntlLike, counts: Record<ExploreBucket, number>) {
  const summaryParts = EXPLORE_BUCKETS.filter((bucket) => counts[bucket] > 0).map(
    (bucket) => `${counts[bucket]} ${getBucketLabel(intl, bucket, counts[bucket])}`,
  );
  return summaryParts.length > 0
    ? summaryParts.join(" · ")
    : intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });
}

function getChildActionKindLabel(
  intl: IntlLike,
  family: ReturnType<typeof resolveToolCallIdentity>["family"],
) {
  if (family === "shell") {
    return intl.formatMessage({ id: "chat.toolCall.execute.running" });
  }
  return intl.formatMessage({ id: "chat.toolCall.status.running" });
}

function renderChildActionKindPrefix(actionKindLabel: string | null, content: ReactNode) {
  if (!actionKindLabel) {
    return content;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      {content}
    </span>
  );
}

function readTodoPlanFromToolCall(
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ZCodePlanStep[] | null {
  return (
    extractPlanStepsFromToolOutput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      output: childToolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      input: childToolCall.input,
    })
  );
}

function getTodoChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ExploreChildSummary | null {
  const plan = readTodoPlanFromToolCall(childToolCall);
  if (!plan || plan.length === 0) {
    return {
      animationKey: `todo:${childToolCall.toolId}:empty`,
      primaryText: (
        <span className="min-w-0 truncate">
          {intl.formatMessage({ id: "chat.toolCall.todo.updating" })}
        </span>
      ),
      title: childToolCall.title,
    };
  }

  const completedCount = plan.filter((step) => step.status === "completed").length;
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan.at(-1);
  const isComplete = completedCount === plan.length;
  const actionLabel = intl.formatMessage({
    id: isComplete ? "chat.toolCall.todo.updated" : "chat.toolCall.todo.updating",
  });
  const progressText = `${completedCount}/${plan.length}`;
  const primaryText = activeStep?.title ? `${progressText} · ${activeStep.title}` : progressText;

  return {
    animationKey: `todo:${childToolCall.toolId}:${completedCount}:${plan.length}:${activeStep?.id ?? "none"}:${activeStep?.title ?? ""}`,
    primaryText: (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-foreground-subtle">{actionLabel}</span>
        <span className="min-w-0 truncate">{primaryText}</span>
      </span>
    ),
    title: activeStep?.title ?? childToolCall.title,
  };
}

function getLatestExploreChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
): ExploreChildSummary | null {
  const childIdentity = resolveToolCallIdentity(childToolCall);
  const activity = classifyToolCallActivity(childToolCall);
  const childIsRunning = isToolCallActivityRunning(childToolCall);
  const actionKindLabel =
    options.includeChildActionKindLabel === true && activity === "unknown"
      ? getChildActionKindLabel(intl, childIdentity.family)
      : null;

  if (childIdentity.family === "todo") {
    return getTodoChildSummary(intl, childToolCall);
  }

  if (activity === "file-read" || activity === "directory-list") {
    const readSummary = buildReadSummary(childToolCall);
    if (!readSummary) {
      return null;
    }
    const canOpenPreview = readSummary.entryType === "file" && Boolean(context.onOpenCodeViewer);
    const openFilePreview = () => {
      if (readSummary.entryType !== "file") {
        return;
      }

      context.onOpenCodeViewer?.({
        type: "file",
        title: readSummary.fileName,
        path: readSummary.path,
      });
    };

    return {
      animationKey: `read:${childToolCall.toolId}:${activity}:${childIsRunning}:${actionKindLabel ?? "plain"}:${readSummary.path}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-foreground-subtle">
            {intl.formatMessage({
              id: `chat.toolCall.activity.${activity}${childIsRunning ? ".running" : ""}`,
            })}
          </span>
          <ReadFileChip
            summary={readSummary}
            clickable={canOpenPreview}
            onClick={openFilePreview}
          />
        </span>,
      ),
      secondaryText: renderFilePath(readSummary.filePath),
      title: readSummary.path,
    };
  }

  if (activity !== "unknown") {
    const action = intl.formatMessage({
      id: `chat.toolCall.activity.${activity}${childIsRunning ? ".running" : ""}`,
    });
    const target = getToolCallActivityTarget(childToolCall, activity);
    const primaryText = target ? `${action} ${target}` : action;

    return {
      animationKey: `activity:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }

  if (childIdentity.family === "shell") {
    const secondaryText =
      getExecuteSecondaryText(childToolCall.input) ?? childToolCall.title ?? childToolCall.kind;

    return {
      animationKey: `shell:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${secondaryText}`,
      primaryText: actionKindLabel ? (
        <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      ) : null,
      secondaryText: <code className="min-w-0 truncate font-sans">{secondaryText}</code>,
      title: typeof secondaryText === "string" ? secondaryText : childToolCall.title,
    };
  }

  const fallbackText =
    childToolCall.title ??
    childToolCall.kind ??
    intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });

  return {
    animationKey: `tool:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${fallbackText}`,
    primaryText: renderChildActionKindPrefix(
      actionKindLabel,
      <span className="min-w-0 truncate">{fallbackText}</span>,
    ),
    title: typeof fallbackText === "string" ? fallbackText : childToolCall.title,
  };
}

export function getLatestExploreChildSummaryFromChildren(
  intl: IntlLike,
  childToolCalls: readonly TaskChatToolCallTreeNode[],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
) {
  for (let index = childToolCalls.length - 1; index >= 0; index -= 1) {
    const childToolCall = childToolCalls[index]?.toolCall;
    if (!childToolCall) {
      continue;
    }

    const summary = getLatestExploreChildSummary(intl, childToolCall, context, options);
    if (summary) {
      return summary;
    }
  }

  return null;
}

export function ExploreToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  const counts = childToolCalls.reduce<Record<ExploreBucket, number>>(
    (acc, childToolCallNode) => {
      const childToolCall = childToolCallNode.toolCall;
      const bucket = classifyToolCallActivity(childToolCall);
      if (bucket !== "unknown") acc[bucket] += 1;
      return acc;
    },
    Object.fromEntries(EXPLORE_BUCKETS.map((bucket) => [bucket, 0])) as Record<
      ExploreBucket,
      number
    >,
  );
  const summary = formatExploreSummary(intl, counts);
  const hasWebActivity = counts["web-search"] + counts["web-read"] > 0;
  const hasFileActivity =
    counts["file-search"] + counts["file-find"] + counts["directory-list"] + counts["file-read"] >
    0;
  const kindLabel = intl.formatMessage({
    id:
      hasWebActivity && !hasFileActivity
        ? "chat.toolCall.activity.group.web"
        : hasFileActivity && !hasWebActivity
          ? "chat.toolCall.activity.group.file"
          : "chat.toolCall.explore.label",
  });
  const collapsedChildSummary = isRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context)
    : null;
  const renderContent = useCallback(
    () =>
      childToolCalls.length > 0 ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              workspacePath={context.workspacePath}
              showIcon={false}
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenBrowserUrl={context.onOpenBrowserUrl}
              onOpenAutomationsMain={context.onOpenAutomationsMain}
              onLoadFullToolCallFields={context.onLoadFullToolCallFields}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.workspacePath,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EXPLORE_TOOL_ICON}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={kindLabel}
        expandedKindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={collapsedChildSummary ? collapsedChildSummary.primaryText : summary}
        expandedPrimaryText={summary}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ??
          `explore:${toolCall.toolId}:${isRunning ? "running" : "done"}:${summary}`
        }
        statusLabel={statusLabel}
        statusTooltip={
          toolCall.status === "failed" || toolCall.status === "denied" ? errorText : undefined
        }
        showFailureStatus={toolCall.status === "failed" || toolCall.status === "denied"}
        showStatusLabel={toolCall.status === "stopped"}
        isRunning={isRunning}
        title={collapsedChildSummary?.title ?? (isRunning ? summary : toolCall.title)}
        expandedTitle={toolCall.title}
        renderContent={renderContent}
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
