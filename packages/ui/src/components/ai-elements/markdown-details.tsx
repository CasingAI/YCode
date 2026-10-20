"use client";

import { ChevronDownIcon } from "lucide-react";
import { Children, isValidElement, useId, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

function isMeaningfulChild(child: ReactNode): boolean {
  if (typeof child === "string") return child.trim().length > 0;
  return true;
}

function findSummaryContent(children: ReactNode): {
  summary: ReactNode | null;
  body: ReactNode;
} {
  // CommonMark 保证 summary 是 details 的第一个子元素；流式期间 summary 未到达时
  // 按「无 summary」处理，头部先出占位文本，内容随 chunk 更新。
  const meaningful = Children.toArray(children).filter(isMeaningfulChild);
  const first = meaningful[0];
  if (isValidElement(first) && first.type === MarkdownSummary) {
    return {
      summary: (first.props as { children?: ReactNode }).children ?? null,
      body: meaningful.slice(1),
    };
  }
  return { summary: null, body: meaningful };
}

// 渲染为 div 卡片而非原生 details 元素，ref 不再有意义；剥离以避免
// Ref<HTMLDetailsElement> 与 div 展开目标不兼容。
type MarkdownDetailsProps = Omit<ComponentProps<"details">, "ref"> & { node?: unknown };

/**
 * 正文 `<details>` 的卡片化渲染，接管原生折叠行为：默认收起，显式 `open` 属性
 * 作为初始展开状态。折叠区始终挂载（grid-rows 收起），避免流式更新与图片重载。
 */
export function MarkdownDetails({
  children,
  className,
  open,
  node: _node,
  ...props
}: MarkdownDetailsProps) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(Boolean(open));
  const regionId = useId();
  const { summary, body } = findSummaryContent(children);

  return (
    <div
      className={cn("my-4 overflow-hidden rounded-xl border border-border bg-card", className)}
      {...(props as ComponentProps<"div">)}
    >
      <button
        type="button"
        aria-controls={regionId}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-foreground-subtle transition-transform duration-200",
            expanded ? "rotate-180" : undefined,
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium">
          {summary ?? intl.formatMessage({ id: "chat.markdown.details.fallback" })}
        </span>
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {/* 顶层段落的间距来自 Streamdown 根容器的 space-y-4，段落 p 自身没有 margin；
              折叠区是嵌套容器，必须自带同一套块间距，否则内部段落会紧贴。 */}
          <div
            className="space-y-4 border-t border-border px-3 py-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            id={regionId}
            role="region"
          >
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 正文 `<summary>` 的渲染。出现在 MarkdownDetails 内时其 children 会被提取进卡片
 * 头部，本组件只负责兜底：`summary` 单独出现在 details 外（畸形输出）时降级为
 * 加粗行，避免裸浏览器样式。
 */
export function MarkdownSummary({
  children,
  className,
  node: _node,
  ...props
}: Omit<ComponentProps<"summary">, "ref"> & { node?: unknown }) {
  return (
    <span className={cn("font-medium", className)} {...(props as ComponentProps<"span">)}>
      {children}
    </span>
  );
}
