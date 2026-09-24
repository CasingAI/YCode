import { GaugeIcon } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Progress } from "@/components/ui/progress.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import {
  formatCompactTokenNumberWithMetricUnits,
  formatContextUsageSummary,
} from "@/lib/tokenNumberFormat.js";
import {
  toolCallGetContextUsageDisplaySchema,
  type ToolCallGetContextUsageDisplay,
} from "@zcode/shared/zcode-protocol-v4";

const GET_CONTEXT_USAGE_ICON = <GaugeIcon className="size-4 shrink-0 text-foreground-subtle" />;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readLegacyContextUsage(
  context: ToolCallBlockRenderContext,
): ToolCallGetContextUsageDisplay | undefined {
  const { toolCall } = context.toolCallNode;
  const raw = isRecord(toolCall.raw) ? toolCall.raw : undefined;
  for (const candidate of [toolCall.output, raw?.rawOutput, raw?.output]) {
    const record = readJsonRecord(candidate);
    if (!record) continue;
    const parsed = toolCallGetContextUsageDisplaySchema.safeParse({
      kind: "get_context_usage",
      ...record,
    });
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function readContextUsage(
  context: ToolCallBlockRenderContext,
): ToolCallGetContextUsageDisplay | undefined {
  const display = readToolResultDisplay(context.toolCallNode.toolCall.raw);
  return display?.kind === "get_context_usage" ? display : readLegacyContextUsage(context);
}

function normalizePercent(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

function formatPercent(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value / 100);
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-ui-sm font-medium text-foreground-subtle">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-ui-base tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}

export function GetContextUsageToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl, locale } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const isFailed = toolCall.status === "failed";
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isUnsuccessful = isFailed || isDenied || isStopped;
  const isCompleted = toolCall.status === "completed";
  // 运行或失败帧可能暂存上一条调用的 output；只有已完成帧才允许解释快照，避免展示陈旧容量。
  const usage = isCompleted && !context.isRunning ? readContextUsage(context) : undefined;
  const hasUsage = usage !== undefined;
  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.getContextUsage.reading"
      : "chat.toolCall.kind.getContextUsage",
  });
  const statusLabel = isFailed
    ? intl.formatMessage({ id: "chat.toolCall.status.failed" })
    : isDenied
      ? intl.formatMessage({ id: "chat.toolCall.status.denied" })
      : isStopped
        ? intl.formatMessage({ id: "chat.toolCall.status.stopped" })
        : hasUsage
          ? intl.formatMessage({ id: "chat.toolCall.getContextUsage.read" })
          : isCompleted
            ? intl.formatMessage({ id: "chat.toolCall.getContextUsage.unavailable" })
            : undefined;
  const usedPercent = usage ? normalizePercent(usage.usedPercent) : 0;
  const percentLabel = usage ? formatPercent(locale, usedPercent) : undefined;
  const primaryLabel = usage
    ? formatContextUsageSummary({
        locale: locale,
        percent: usedPercent / 100,
        size: usage.effectiveContextWindowTokens,
        used: usage.usedTokens,
      })
    : kindLabel;
  const remainingLabel = usage
    ? intl.formatMessage(
        { id: "chat.toolCall.getContextUsage.remainingSummary" },
        { tokens: formatCompactTokenNumberWithMetricUnits(usage.remainingTokens) },
      )
    : undefined;
  const primaryText = useMemo(
    () =>
      usage ? (
        <span className="min-w-0 flex-1 truncate font-mono tabular-nums">{primaryLabel}</span>
      ) : undefined,
    [primaryLabel, usage],
  );
  const remainingText = remainingLabel ? (
    <span className="shrink-0 whitespace-nowrap">{remainingLabel}</span>
  ) : undefined;
  const compactCompletedLabel =
    hasUsage && !isUnsuccessful ? (
      <span className="@max-[480px]/conversation:hidden">{kindLabel}</span>
    ) : (
      kindLabel
    );
  const compactCompletedStatus =
    hasUsage && !isUnsuccessful && statusLabel != null ? (
      <span className="@max-[480px]/conversation:hidden">{statusLabel}</span>
    ) : (
      statusLabel
    );

  const renderContent = useCallback(() => {
    if (!usage) {
      return (
        <div className="rounded-lg border border-border bg-panel px-4 py-3">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.getContextUsage.invalidResult" })}
          </p>
        </div>
      );
    }

    const token = (value: number) => formatCompactTokenNumberWithMetricUnits(value);
    const source = intl.formatMessage({
      id:
        usage.tokenSource === "provider_usage"
          ? "chat.toolCall.getContextUsage.source.providerUsage"
          : "chat.toolCall.getContextUsage.source.estimate",
    });

    return (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "chat.toolCall.getContextUsage.effectiveUsage" })}
          </span>
          <span className="font-mono text-ui-base tabular-nums text-foreground">
            {formatContextUsageSummary({
              locale: locale,
              percent: usedPercent / 100,
              size: usage.effectiveContextWindowTokens,
              used: usage.usedTokens,
            })}
          </span>
        </div>
        <Progress
          value={usedPercent}
          className="mt-3 h-1.5"
          aria-label={intl.formatMessage({ id: "chat.toolCall.getContextUsage.progress" })}
          indicatorClassName="min-w-2"
        />
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 @min-[769px]/conversation:grid-cols-2">
          <DetailField
            label={intl.formatMessage({ id: "chat.toolCall.getContextUsage.used" })}
            value={`${token(usage.usedTokens)} (${percentLabel})`}
          />
          <DetailField
            label={intl.formatMessage({ id: "chat.toolCall.getContextUsage.remaining" })}
            value={`${token(usage.remainingTokens)} (${formatPercent(locale, normalizePercent(usage.remainingPercent))})`}
          />
          <DetailField
            label={intl.formatMessage({ id: "chat.toolCall.getContextUsage.effectiveWindow" })}
            value={token(usage.effectiveContextWindowTokens)}
          />
          <DetailField
            label={intl.formatMessage({ id: "chat.toolCall.getContextUsage.autoCompactThreshold" })}
            value={token(usage.autocompactThresholdTokens)}
          />
          <DetailField
            label={intl.formatMessage({ id: "chat.toolCall.getContextUsage.contextWindow" })}
            value={token(usage.contextWindowTokens)}
          />
          <DetailField
            label={intl.formatMessage({ id: "chat.toolCall.getContextUsage.tokenSource" })}
            value={source}
          />
        </dl>
      </div>
    );
  }, [intl, locale, percentLabel, usedPercent, usage]);

  const hasDetails = hasUsage || (isCompleted && !isUnsuccessful);

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={GET_CONTEXT_USAGE_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={compactCompletedLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        prioritizePrimaryText
        secondaryText={remainingText}
        statusLabel={compactCompletedStatus}
        showStatusLabel={statusLabel != null}
        statusTooltip={isFailed ? context.errorText : undefined}
        showFailureStatus={isUnsuccessful}
        isRunning={context.isRunning}
        title={kindLabel}
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
