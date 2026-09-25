import { ListChecksIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";

const LIST_PLANS_ICON = <ListChecksIcon className="size-4 shrink-0 text-foreground-subtle" />;

export function ListPlansToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const isCompleted = toolCall.status === "completed";
  const isFailed = toolCall.status === "failed";
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isUnsuccessful = isFailed || isDenied || isStopped;
  const display =
    isCompleted && !context.isRunning ? readToolResultDisplay(toolCall.raw) : undefined;

  if (isCompleted && !context.isRunning && !display) {
    return <FallbackToolCallBlock {...context} />;
  }

  if (display?.kind !== "list_plans") {
    return (
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_PLANS_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={
          context.isRunning
            ? intl.formatMessage({ id: "chat.toolCall.listPlans.reading" })
            : intl.formatMessage({ id: "chat.toolCall.kind.listPlans" })
        }
        primaryText={undefined}
        statusLabel={isUnsuccessful ? context.statusLabel : undefined}
        statusTooltip={context.errorText}
        showFailureStatus={isUnsuccessful}
        isRunning={context.isRunning}
        title={toolCall.title}
      />
    );
  }

  const planCount = display.planCount;
  const hasPlans = planCount > 0;
  const summaryAction =
    hasPlans && context.onOpenPlanDirectory
      ? {
          ariaLabel: intl.formatMessage({ id: "chat.toolCall.listPlans.openDirectory" }),
          onActivate: context.onOpenPlanDirectory,
          testId: `list-plans-directory-${toolCall.toolId}`,
        }
      : undefined;

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={LIST_PLANS_ICON}
      showIcon={context.showIcon !== false}
      canToggle={false}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.kind.listPlans" })}
      primaryText={
        hasPlans
          ? intl.formatMessage(
              { id: "chat.toolCall.listPlans.found" },
              { count: String(planCount) },
            )
          : intl.formatMessage({ id: "chat.toolCall.listPlans.empty" })
      }
      statusLabel={context.statusLabel}
      statusTooltip={context.errorText}
      showFailureStatus={isUnsuccessful}
      isRunning={context.isRunning}
      title={toolCall.title}
      summaryAction={summaryAction}
    />
  );
}
