import type { CSSProperties } from "react";
import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildContextUsageBreakdownSegments,
  sortContextUsageBreakdownSegments,
  type ContextUsageBreakdownSegment,
} from "@/lib/contextUsageBreakdown.js";
import {
  formatContextUsageBreakdownLabel,
  formatContextUsageSummary,
} from "@/lib/tokenNumberFormat.js";

const CONTEXT_PROGRESS_TONE_COLORS = [
  "var(--color-usage-chart-1)",
  "color-mix(in oklab, var(--color-usage-chart-1) 78%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 58%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 42%, var(--color-surface))",
  "color-mix(in oklab, var(--color-usage-chart-1) 28%, var(--color-surface))",
] as const;

const BREAKDOWN_SOURCE_LABEL_ID: Record<ContextUsageBreakdownSegment["source"], string> = {
  messages: "chat.contextUsage.breakdown.messages",
  system_prompt: "chat.contextUsage.breakdown.systemPrompt",
  meta_user_context: "chat.contextUsage.breakdown.metaUserContext",
  skills: "chat.contextUsage.breakdown.skills",
  tool_prompt: "chat.contextUsage.breakdown.toolPrompt",
  system_tool_schemas: "chat.contextUsage.breakdown.systemTools",
  mcp_tool_schemas: "chat.contextUsage.breakdown.mcpTools",
};

function getBreakdownToneStyle(index: number): CSSProperties {
  return {
    backgroundColor:
      CONTEXT_PROGRESS_TONE_COLORS[Math.min(index, CONTEXT_PROGRESS_TONE_COLORS.length - 1)] ??
      CONTEXT_PROGRESS_TONE_COLORS[0],
  };
}

export function resolveContextUsageDisplayBreakdown(
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | undefined,
  usedTokens: number | undefined,
): ContextUsageBreakdownSegment[] {
  return sortContextUsageBreakdownSegments(
    buildContextUsageBreakdownSegments(breakdown, usedTokens),
  );
}

function formatCacheHitRate(hitRate: number | null | undefined, locale: string): string | null {
  if (hitRate === null || hitRate === undefined || !Number.isFinite(hitRate)) return null;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.max(0, hitRate));
}

export interface ContextUsageDisplayProps {
  usedTokens: number;
  maxTokens: number;
  breakdown?: readonly ZCodeContextUsageBreakdownItem[];
  cacheHitRate?: number | null;
  density?: "toolbar" | "footer";
  className?: string;
  "data-testid"?: string;
}

export function ContextUsageTrigger({
  usedTokens,
  maxTokens,
  density = "toolbar",
  className,
  "data-testid": dataTestId,
}: Pick<
  ContextUsageDisplayProps,
  "usedTokens" | "maxTokens" | "density" | "className" | "data-testid"
>) {
  return (
    <span
      data-testid={dataTestId}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-ui-base text-foreground-subtle hover:bg-hover hover:text-foreground",
        density === "footer" && "h-7 cursor-default",
        className,
      )}
    >
      <ContextTriggerIcon usedTokens={usedTokens} maxTokens={maxTokens} />
    </span>
  );
}

export function ContextUsageDetails({
  usedTokens,
  maxTokens,
  breakdown,
  cacheHitRate,
}: ContextUsageDisplayProps) {
  const { intl, locale } = useZCodeIntl();
  const usagePercent = Math.min(Math.max(usedTokens / maxTokens, 0), 1);
  const summary = formatContextUsageSummary({
    locale,
    percent: usagePercent,
    size: maxTokens,
    used: usedTokens,
  });
  const cacheHitRateLabel = formatCacheHitRate(cacheHitRate, locale);
  const segments = resolveContextUsageDisplayBreakdown(breakdown, usedTokens);
  const progressSegments = segments.map((segment, index) => ({
    id: segment.source,
    percent: segment.percent,
    style: getBreakdownToneStyle(index),
  }));

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "chat.contextUsage.title" })}
          </span>
          <span className="ml-auto shrink-0 text-right font-mono text-ui-sm text-foreground-subtle">
            {summary}
          </span>
        </div>
        <Progress
          className="h-2 bg-surface"
          indicatorClassName="min-w-2"
          segments={progressSegments}
          value={usagePercent * 100}
        />
      </div>
      {segments.length > 0 || cacheHitRateLabel ? (
        <>
          {segments.length > 0 ? (
            <div
              aria-label={intl.formatMessage({ id: "chat.contextUsage.breakdown" })}
              className="space-y-1.5"
            >
              <div className="grid gap-1.5">
                {segments.map((segment, index) => (
                  <div className="flex min-w-0 items-center gap-2 text-ui-sm" key={segment.source}>
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-sm border border-border"
                      style={getBreakdownToneStyle(index)}
                    />
                    <span className="min-w-0 truncate text-foreground-subtle">
                      {intl.formatMessage({ id: BREAKDOWN_SOURCE_LABEL_ID[segment.source] })}
                    </span>
                    <span className="ml-auto min-w-16 shrink-0 whitespace-nowrap text-right font-mono text-ui-sm tabular-nums text-foreground">
                      {formatContextUsageBreakdownLabel({
                        locale,
                        percent: segment.percent,
                        tokens: segment.displayTokens,
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {cacheHitRateLabel ? (
            <div
              className={cn(
                "flex items-center justify-between gap-3 text-ui-sm",
                segments.length > 0 && "border-t border-border pt-3",
              )}
            >
              <span className="text-foreground-subtle">
                {intl.formatMessage({ id: "chat.contextUsage.cacheHitRate" })}
              </span>
              <span className="font-mono text-ui-sm text-foreground">{cacheHitRateLabel}</span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ContextTriggerIcon({ usedTokens, maxTokens }: { usedTokens: number; maxTokens: number }) {
  const circumference = 2 * Math.PI * 10;
  const percent = Math.min(Math.max(usedTokens / maxTokens, 0), 1);
  return (
    <svg aria-hidden="true" className="size-3.5 shrink-0" focusable="false" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        fill="none"
        opacity="0.25"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <circle
        cx="12"
        cy="12"
        fill="none"
        opacity="0.7"
        r="10"
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - percent)}
        strokeLinecap="round"
        strokeWidth="4"
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
}
