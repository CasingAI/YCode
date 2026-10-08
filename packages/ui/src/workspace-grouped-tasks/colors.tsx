import type { ZCodeTaskGroupColor } from "@zcode/services";
import { Hash } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { TASK_GROUP_COLOR_CLASS } from "@/workspace-grouped-tasks/types.js";

function TaskGroupColorMark({ color, emoji }: { color: ZCodeTaskGroupColor; emoji?: string }) {
  return (
    <span
      className={cn(
        // 与置顶行紧凑 Tag（task-group-tag.tsx）同尺寸：26px 圆、圆内 emoji 字号 16px。
        // 无 emoji 的 Hash 图标 16px，与圆的比例和此前一致（12px/20px）。
        "flex size-[26px] shrink-0 items-center justify-center rounded-full",
        TASK_GROUP_COLOR_CLASS[color],
      )}
    >
      {/* 配了 emoji 的组：圆内显示 emoji 替代 # 图标（与行 Tag 的图标语义一致）。
          emoji 字号 16px 是实测定的：Apple Color Emoji 是位图字体，ink bbox 远大于
          font-size（22px 字号实测 ink 25×26px，正好等于圆的 26px 内径，零边距 → 用户
          截图里「火箭超出圆盘」）；16px 字号 ink 22×22px，四周留 2px 边距。
          该字号的 ink 中心比 line box 中心低 1px（位图字形 ascent 大于 descent），
          圆居中 line box，所以 span 再上移 1px 才是视觉居中。
          实测在 DPR1/DPR2 下 ink 尺寸相同，结论可迁移到 Retina。 */}
      {emoji ? (
        <span className="text-[16px] leading-none -translate-y-px">{emoji}</span>
      ) : (
        <Hash className="size-4" />
      )}
    </span>
  );
}

function TaskGroupColorDot({ color }: { color: ZCodeTaskGroupColor }) {
  return <span className={cn("size-2.5 shrink-0 rounded-full", TASK_GROUP_COLOR_CLASS[color])} />;
}

export { TaskGroupColorDot, TaskGroupColorMark };
