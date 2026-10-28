import { SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  FileDisplayIcon,
  FOLDER_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { renderFilePath } from "../shared.js";
import { classifyToolCallActivity, isToolCallActivityRunning } from "@/lib/toolCallActivity.js";
import { readToolMetadata } from "@/lib/readToolMetadata.js";

const READ_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

export type ReadSummary = {
  path: string;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  entryType: "file" | "directory";
};

function createReadSummary(
  path: string,
  options: {
    fileName?: string;
    entryType?: "file" | "directory";
  } = {},
): ReadSummary {
  const entryType = options.entryType ?? "file";
  const descriptor = resolveFileDisplayDescriptor(path);

  return {
    path,
    fileName: options.fileName ?? descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: entryType === "directory" ? FOLDER_FILE_ICON_SRC : descriptor.fileIconSrc,
    entryType,
  };
}

export function buildReadSummary(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ReadSummary | null {
  const metadata = readToolMetadata(toolCall.input, toolCall.raw, toolCall.output);
  const path = metadata.path;
  const entryType = metadata.entryType;
  if (path) {
    return createReadSummary(path, { fileName: metadata.fileName, entryType });
  }
  return null;
}

export function ReadFileChip({
  summary,
  clickable,
  onClick,
}: {
  summary: ReadSummary;
  clickable: boolean;
  onClick?: () => void;
}) {
  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-foreground-subtle hover:underline"
        title={summary.path}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{summary.fileName}</span>
      </button>
    );
  }

  return (
    <span
      className="inline-flex min-w-0 text-foreground-subtle max-w-full items-center gap-1.5"
      title={summary.path}
    >
      <FileDisplayIcon src={summary.fileIconSrc} size={16} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{summary.fileName}</span>
    </span>
  );
}

export function ReadToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, statusLabel, errorText, onOpenCodeViewer } = context;
  const { toolCall } = toolCallNode;
  const summary = buildReadSummary(toolCall);
  const activity = classifyToolCallActivity(toolCall);
  const isRunning = isToolCallActivityRunning(toolCall);
  const actionId = `chat.toolCall.activity.${activity}`;
  const canOpenPreview = summary?.entryType === "file" && Boolean(onOpenCodeViewer);
  const openFilePreview = useCallback(() => {
    if (!summary || summary.entryType !== "file" || !onOpenCodeViewer) {
      return;
    }

    onOpenCodeViewer({
      type: "file",
      title: summary.fileName,
      path: summary.path,
    });
  }, [onOpenCodeViewer, summary]);
  const primaryText = useMemo(
    () =>
      summary ? (
        <ReadFileChip summary={summary} clickable={canOpenPreview} onClick={openFilePreview} />
      ) : null,
    [canOpenPreview, openFilePreview, summary],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={READ_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={intl.formatMessage({
          id: isRunning && activity !== "unknown" ? `${actionId}.running` : actionId,
        })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        secondaryText={summary ? renderFilePath(summary.filePath) : undefined}
        statusLabel={statusLabel}
        statusTooltip={
          toolCall.status === "failed" || toolCall.status === "denied" ? errorText : undefined
        }
        showFailureStatus={toolCall.status === "failed" || toolCall.status === "denied"}
        showStatusLabel={toolCall.status === "stopped"}
        isRunning={isRunning}
        title={toolCall.title}
        content={null}
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
