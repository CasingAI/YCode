import { SearchIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import {
  classifyToolCallActivity,
  getToolCallActivityTarget,
  isToolCallActivityRunning,
  type ToolCallActivityInput,
} from "@/lib/toolCallActivity.js";

const SEARCH_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

export function getSearchPrimaryText(
  _intl: IntlLike,
  input: unknown,
  tool?: ToolCallActivityInput,
): string | null {
  return getToolCallActivityTarget({ ...tool, input });
}

export function SearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const activity = classifyToolCallActivity(toolCall);
  const isRunning = isToolCallActivityRunning(toolCall);
  const target = getSearchPrimaryText(intl, toolCall.input, toolCall);
  const kindLabelId =
    activity === "unknown"
      ? "chat.toolCall.activity.unknown"
      : `chat.toolCall.activity.${activity}${isRunning ? ".running" : ""}`;
  const isFailed = toolCall.status === "failed" || toolCall.status === "denied";

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEARCH_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={context.kindLabelOverride ?? intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={target ? <span className="truncate">{target}</span> : null}
        statusLabel={statusLabel}
        statusTooltip={isFailed ? errorText : undefined}
        showFailureStatus={isFailed}
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
