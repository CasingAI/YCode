import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { writeTextToClipboard } from "@/lib/clipboard.js";
import { resolveFailureDetailPointerAction } from "@/ToolCallBlocks/toolStatusWordInteraction.js";

const COPY_FEEDBACK_RESET_MS = 1500;

interface ToolStatusWordProps {
  /** 状态词本身（如「执行失败」）。 */
  label: ReactNode;
  /** 失败详情。存在时状态词成为气泡触发区；缺省时只渲染纯文字状态词。 */
  detail?: ReactNode;
}

/**
 * 工具摘要行上的状态词与失败详情气泡。
 *
 * 气泡的开关状态由本组件持有（受控 Tooltip），Radix 只负责定位、悬停宽限区和浮层
 * 行为。桌面端仍走 Radix 的悬停路径；触摸端没有悬停，Radix 的三条打开路径在手指
 * 点按下全部落空（`pointermove` 对 touch 直接返回、`span` 不可聚焦、`click` 的语义
 * 是关闭），所以触摸在 `pointerdown` 阶段自己打开。
 */
export function ToolStatusWord({ label, detail }: ToolStatusWordProps) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  // 记录最近一次指针类型：click 事件本身不带 pointerType，只能回看 pointerdown。
  const lastPointerTypeRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const copyableDetail = typeof detail === "string" && detail.trim().length > 0 ? detail : null;

  const handleCopy = () => {
    if (copyableDetail === null) {
      return;
    }

    void writeTextToClipboard(copyableDetail)
      .then(() => {
        setCopied(true);
        if (copyResetRef.current !== null) {
          window.clearTimeout(copyResetRef.current);
        }
        copyResetRef.current = window.setTimeout(() => {
          setCopied(false);
          copyResetRef.current = null;
        }, COPY_FEEDBACK_RESET_MS);
      })
      .catch((error: unknown) => {
        toast(
          intl.formatMessage(
            { id: "clipboard.copyFailed" },
            { error: error instanceof Error ? error.message : String(error) },
          ),
          { variant: "warning" },
        );
      });
  };

  if (!detail) {
    return <span className="whitespace-nowrap">{label}</span>;
  }

  const copyLabel = intl.formatMessage({
    id: copied ? "chat.toolCall.copyError.copied" : "chat.toolCall.copyError",
  });

  return (
    <TooltipProvider>
      <Tooltip interactive open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            className="whitespace-nowrap underline decoration-dotted underline-offset-2 cursor-help"
            onPointerDown={(event) => {
              lastPointerTypeRef.current = event.pointerType;
              if (resolveFailureDetailPointerAction(event.pointerType) !== "open-and-keep") {
                return;
              }
              // 触摸端必须自己打开：Radix 的 pointermove 路径对 touch 直接返回，
              // focus 路径要求触发区可聚焦（这里是 span），click 路径只会关闭气泡。
              // 同一事件里 Radix 读到的仍是本轮渲染的旧值 open === false，
              // 不会执行「已打开则关闭」，因此这里打开后能留住。
              setOpen(true);
            }}
            onClick={(event) => {
              if (
                resolveFailureDetailPointerAction(lastPointerTypeRef.current) !== "open-and-keep"
              ) {
                return;
              }
              // Radix trigger 的 click 语义是「关闭气泡」。触摸刚在 pointerdown 打开过，
              // 必须放行这次 click，否则气泡开了又被同一次点按关掉。
              event.preventDefault();
            }}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" interactive className="max-w-96">
          <div className="flex max-w-96 items-center gap-2">
            <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
              {detail}
            </span>
            {copyableDetail !== null ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                className="shrink-0"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleCopy();
                }}
                title={copyLabel}
                aria-label={copyLabel}
              >
                {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              </Button>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
