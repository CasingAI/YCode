import { Info } from "lucide-react";
import { TID_CHAT_TURN_INFO_DIALOG, TID_CHAT_TURN_INFO_TRIGGER, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationTurnInfoContent } from "@/v4/ConversationTurnInfoContent.js";
import { buildConversationTurnInfoFacts } from "@/v4/conversationTurnInfo.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";

/**
 * 统计栏最右侧的常驻信息入口。Dialog 使用局部开放状态（Radix Trigger），
 * 不写入会话状态、不切换工作过程折叠。
 */
export function ConversationTurnInfoAction({
  segment,
  turnId,
  className,
}: {
  segment: ConversationTurnWorkSegment;
  turnId: string;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "chat.turnInfo.open" });
  const title = intl.formatMessage({ id: "chat.turnInfo.title" });
  const facts = buildConversationTurnInfoFacts({ segment, turnId });

  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className={cn(className)}
              data-testid={testId(TID_CHAT_TURN_INFO_TRIGGER, segment.key)}
            >
              <Info className="size-3.5" aria-hidden="true" />
              <span className="sr-only">{label}</span>
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DialogContent
        // 标题下不显示可见描述：显式关闭 aria-describedby，保留标题作为可访问名称。
        aria-describedby={undefined}
        data-testid={testId(TID_CHAT_TURN_INFO_DIALOG, segment.key)}
        className="max-h-[calc(100dvh-2rem)] w-[min(420px,calc(100vw-2rem))] overflow-y-auto"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
            <Info className="size-4" aria-hidden="true" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <ConversationTurnInfoContent facts={facts} />
      </DialogContent>
    </Dialog>
  );
}
