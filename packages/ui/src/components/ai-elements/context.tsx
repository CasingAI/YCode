/*
 * Derived from vercel/ai-elements (packages/elements/src/context.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card.js";
import { Progress } from "../ui/progress.js";
import { cn } from "../lib/utils.js";
import type { LanguageModelUsage } from "ai";
import { Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { getUsage } from "tokenlens";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 4;
/** 面板与触发器之间的视觉留白（px）。 */
export const CONTEXT_PANEL_TRIGGER_GAP_PX = 2;

/** 视觉留白加 1px 重叠余量，需与下方 Tailwind 静态类名 h-[3px] 同步。 */
export const CONTEXT_TRIGGER_HIT_BRIDGE_PX = CONTEXT_PANEL_TRIGGER_GAP_PX + 1;

// HoverCard 没有 Tooltip 那样的安全多边形，closeDelay=0 会在慢速跨留白时关闭。
// 透明伪元素保留视觉留白且不中断触发器命中；上下两侧兼容浮层碰撞翻转。
// Button 的 1px border 不计入绝对定位包含块，需外扩 1px 才能对齐 border box，
// 完整跨过 2px 留白并与面板重叠 1px。仅精细指针启用，不扩大手机端点击热区。
const CONTEXT_TRIGGER_HIT_BRIDGE_CLASS = cn(
  "relative",
  "pointer-fine:before:absolute pointer-fine:before:-inset-x-px pointer-fine:before:bottom-[calc(100%+1px)] pointer-fine:before:h-[3px] pointer-fine:before:content-['']",
  "pointer-fine:after:absolute pointer-fine:after:-inset-x-px pointer-fine:after:top-[calc(100%+1px)] pointer-fine:after:h-[3px] pointer-fine:after:content-['']",
);

type ModelId = string;

interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
}

const ContextContext = createContext<ContextSchema | null>(null);

function formatFullNumber(value: number) {
  return new Intl.NumberFormat(undefined).format(value);
}

function formatUsagePercent(usedTokens: number, maxTokens: number) {
  if (maxTokens <= 0) {
    return 0;
  }

  return Math.min(Math.max(usedTokens / maxTokens, 0), 1);
}

const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error("Context components must be used within Context");
  }

  return context;
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => {
  const contextValue = useMemo(
    () => ({ maxTokens, modelId, usage, usedTokens }),
    [maxTokens, modelId, usage, usedTokens],
  );

  return (
    <ContextContext.Provider value={contextValue}>
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextContext.Provider>
  );
};

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = formatUsagePercent(usedTokens, maxTokens);
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      focusable="false"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button> & {
  /** 触发器转圈：额度自动重置进行中时替换 ContextIcon（对应「正在重置」状态）。 */
  loading?: boolean;
  /**
   * 在默认触发器按钮上下各铺一条透明命中桥，跨过面板与触发器之间的视觉留白。
   * 默认 false，不影响未启用的使用点；仅作用于默认按钮渲染，自定义 children 需自行提供。
   */
  hitBridge?: boolean;
};

export const ContextTrigger = ({
  children,
  loading = false,
  hitBridge = false,
  ...props
}: ContextTriggerProps) => {
  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          {...props}
          data-context-trigger-hit-bridge={hitBridge ? "true" : undefined}
          className={cn(hitBridge && CONTEXT_TRIGGER_HIT_BRIDGE_CLASS, props.className)}
        >
          {loading ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <ContextIcon />
          )}
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({ className, ...props }: ContextContentProps) => (
  <HoverCardContent
    className={cn(
      "!w-64 overflow-hidden rounded-lg border border-border bg-tooltip p-0 text-tooltip-foreground shadow-none ring-0 outline-0",
      className,
    )}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({
  action,
  children,
  className,
  progressSegments,
  ...props
}: ContextContentHeaderProps & {
  action?: ReactNode;
  progressSegments?: readonly {
    className?: string;
    id: string;
    percent: number;
  }[];
}) => {
  const { usedTokens, maxTokens } = useContextValue();
  const usedPercent = formatUsagePercent(usedTokens, maxTokens);
  const displayPct = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(usedPercent);
  const used = formatFullNumber(usedTokens);
  const total = formatFullNumber(maxTokens);

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-ui-base font-medium text-foreground-subtle">Context</p>
            {action}
          </div>
          <div className="border-t border-border" />
          <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
            <p className="text-ui-lg font-medium text-foreground">{displayPct}</p>
            <p>
              {used} / {total}
            </p>
          </div>
          <Progress
            className="h-2 bg-surface"
            indicatorClassName="min-w-2"
            segments={progressSegments}
            value={usedPercent * PERCENT_MAX}
          />
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
  <div className={cn("w-full bg-menu p-3", className)} {...props}>
    {children}
  </div>
);

export type ContextContentFooterProps = ComponentProps<"div">;

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { modelId, usage } = useContextValue();
  const costUSD = modelId
    ? getUsage({
        modelId,
        usage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
        },
      }).costUSD?.totalUSD
    : undefined;
  const totalCost = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(costUSD ?? 0);

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 border-t border-popover-border bg-surface p-3 text-ui-base",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">Total cost</span>
          <span>{totalCost}</span>
        </>
      )}
    </div>
  );
};

const TokensWithCost = ({ tokens, costText }: { tokens?: number; costText?: string }) => (
  <span>
    {tokens === undefined ? "—" : formatCompactTokenNumber("", tokens)}
    {costText ? <span className="ml-2 text-muted-foreground">• {costText}</span> : null}
  </span>
);

export type ContextInputUsageProps = ComponentProps<"div">;

export const ContextInputUsage = ({ className, children, ...props }: ContextInputUsageProps) => {
  const { usage, modelId } = useContextValue();
  const inputTokens = usage?.inputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!inputTokens) {
    return null;
  }

  const inputCost = modelId
    ? getUsage({
        modelId,
        usage: { input: inputTokens, output: 0 },
      }).costUSD?.totalUSD
    : undefined;
  const inputCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(inputCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Input</span>
      <TokensWithCost costText={inputCostText} tokens={inputTokens} />
    </div>
  );
};

export type ContextOutputUsageProps = ComponentProps<"div">;

export const ContextOutputUsage = ({ className, children, ...props }: ContextOutputUsageProps) => {
  const { usage, modelId } = useContextValue();
  const outputTokens = usage?.outputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!outputTokens) {
    return null;
  }

  const outputCost = modelId
    ? getUsage({
        modelId,
        usage: { input: 0, output: outputTokens },
      }).costUSD?.totalUSD
    : undefined;
  const outputCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(outputCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Output</span>
      <TokensWithCost costText={outputCostText} tokens={outputTokens} />
    </div>
  );
};

export type ContextReasoningUsageProps = ComponentProps<"div">;

export const ContextReasoningUsage = ({
  className,
  children,
  ...props
}: ContextReasoningUsageProps) => {
  const { usage, modelId } = useContextValue();
  const reasoningTokens = usage?.reasoningTokens ?? 0;

  if (children) {
    return children;
  }

  if (!reasoningTokens) {
    return null;
  }

  const reasoningCost = modelId
    ? getUsage({
        modelId,
        usage: { reasoningTokens },
      }).costUSD?.totalUSD
    : undefined;
  const reasoningCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(reasoningCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Reasoning</span>
      <TokensWithCost costText={reasoningCostText} tokens={reasoningTokens} />
    </div>
  );
};

export type ContextCacheUsageProps = ComponentProps<"div">;

export const ContextCacheUsage = ({ className, children, ...props }: ContextCacheUsageProps) => {
  const { usage, modelId } = useContextValue();
  const cacheTokens = usage?.cachedInputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!cacheTokens) {
    return null;
  }

  const cacheCost = modelId
    ? getUsage({
        modelId,
        usage: { cacheReads: cacheTokens, input: 0, output: 0 },
      }).costUSD?.totalUSD
    : undefined;
  const cacheCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(cacheCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Cache</span>
      <TokensWithCost costText={cacheCostText} tokens={cacheTokens} />
    </div>
  );
};
