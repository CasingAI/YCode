import type { ZCodeTaskGroupColor } from "@zcode/services";
import { Hash } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { EmojiGlyph } from "@/workspace-grouped-tasks/emoji-glyph.js";
import { TASK_GROUP_COLOR_CLASS } from "@/workspace-grouped-tasks/types.js";

function TaskGroupColorMark({ color, emoji }: { color: ZCodeTaskGroupColor; emoji?: string }) {
  return (
    <span
      className={cn(
        // 与置顶行紧凑 Tag（task-group-tag.tsx）同尺寸：26px 圆、圆内图片 16px。
        // 无 emoji 的 Hash 图标 16px，与圆的比例和此前一致（12px/20px）。
        "flex size-[26px] shrink-0 items-center justify-center rounded-full",
        TASK_GROUP_COLOR_CLASS[color],
      )}
    >
      {/* 配了 emoji 的组：圆内显示本地图片替代 # 图标（与行 Tag 的图标语义一致）。
          图片固定 16px，四周留白由图片自身的透明边距决定，不再依赖系统字体 ink 尺寸。 */}
      {emoji ? <EmojiGlyph emoji={emoji} size={16} /> : <Hash className="size-4" />}
    </span>
  );
}

function TaskGroupColorDot({ color }: { color: ZCodeTaskGroupColor }) {
  return <span className={cn("size-2.5 shrink-0 rounded-full", TASK_GROUP_COLOR_CLASS[color])} />;
}

export { TaskGroupColorDot, TaskGroupColorMark };
