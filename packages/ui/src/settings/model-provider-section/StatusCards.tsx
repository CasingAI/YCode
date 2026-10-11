/* 智谱剥离：Coding Plan/Start Plan/Team 套餐卡已删除，仅保留通用额度卡（见 docs/specs/zhipu-special-removal.md）。 */
import type { UsageQuotaLimit } from "@zcode/shared";
import { InfoIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { formatQuotaModelDisplayName } from "./quotaModelDisplayName.js";

// 智谱剥离：CodingPlanStatusPanel 及套餐相关 helper 已删除，保留通用卡片供模板额度区复用。
// 调用方不得再依赖套餐面板做展示分支。

export function ModelProviderLoadingCard({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" />
        <span>{loadingLabel}</span>
      </div>
    </div>
  );
}

export function PresetProviderPlaceholderCard({
  displayName,
  messageId = "settings.modelProvider.presetEmpty",
}: {
  displayName: string;
  messageId?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="bg-background/50 rounded-2xl p-3">
      <div className="text-ui-lg font-semibold text-foreground">{displayName}</div>
      <div className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: messageId })}
      </div>
    </div>
  );
}


export function PlanUsageMetricCard({
  action,
  detail,
  infoDescription,
  label,
  limit,
  progressColor,
  resetTimeFormat,
}: {
  action?: ReactNode;
  /** 可选次要信息行（如绝对用量/限额），渲染在百分比行下方；不传则无该行。 */
  detail?: string;
  infoDescription?: string;
  label?: string;
  limit?: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}) {
  const { locale } = useZCodeIntl();
  const remainingPercentage = resolveLimitRemainingPercentage(limit);
  const progressPercentage = remainingPercentage ?? 0;
  const modelLabel = limit && limit.type !== "TIME_LIMIT" ? formatLimitModels(limit) : "";
  const resetTime = formatQuotaResetTime({
    locale,
    value: limit?.nextResetTime,
    format: resetTimeFormat,
    compactToday: resetTimeFormat === "dateTime",
  });

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      {label ? (
        // 固定 24px 会让 20px 界面字号的 30px 行盒溢出；最小高度既保持默认对齐，也允许大字号撑高。
        <div className="flex min-h-6 min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{label}</span>
          {infoDescription ? (
            <ControlHintTooltip title={infoDescription} standalone>
              <button
                type="button"
                aria-label={infoDescription}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                data-zcode-mcp-info="model-settings"
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </button>
            </ControlHintTooltip>
          ) : null}
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
      ) : null}
      {modelLabel ? (
        <div className={`truncate text-ui-xs text-foreground-subtle ${label ? "mt-1" : ""}`}>
          {modelLabel}
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
        <span className="text-ui-lg font-semibold leading-none text-foreground">
          {formatRemainingPercentage(locale, remainingPercentage)}
        </span>
        {resetTime ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
      {detail ? (
        <div className="mt-1 truncate text-ui-xs text-foreground-subtle">{detail}</div>
      ) : null}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${progressPercentage}%`,
            backgroundColor: progressColor,
          }}
        />
      </div>
    </div>
  );
}

function resolveLimitRemainingPercentage(limit: UsageQuotaLimit | undefined): number | null {
  const usedPercentage = normalizeUsagePercentage(limit?.percentage);
  if (usedPercentage !== null) {
    // Coding Plan quota 接口的 percentage 是已用百分比，
    // Plan Card 属于“剩余额度”视图，需要和侧边栏剩余用量菜单一致反转展示。
    return Math.max(0, Math.min(100, 100 - usedPercentage));
  }
  const remaining = limit?.remaining;
  const total = limit?.number;
  if (
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  }
  return null;
}

function normalizeUsagePercentage(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function formatRemainingPercentage(locale: string, value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(Math.max(0, Math.min(100, value)))}%`;
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  return Array.from(new Set(modelNames)).join(" / ");
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode
    .replace(/^model:/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return normalized || modelCode;
}
