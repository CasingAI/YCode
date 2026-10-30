import { firstGraphemeOf } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { EmojiGlyph } from "@/workspace-grouped-tasks/emoji-glyph.js";
import { TASK_GROUP_COLOR_CLASS } from "@/workspace-grouped-tasks/types.js";
import type { TaskGroupTagInfo } from "@/hooks/useTaskGroupTagMap.js";

// 任务行所属分组 Tag。
// 完整态（compact 缺省）：[图标段 ＋ 文本段] pill。图标段＝本地 emoji 图片（有）
// 或标题首 grapheme（无），带组颜色背景，shrink-0 永不压缩；文本段＝组标题 truncate。
// 空间被挤时文本先被挤掉，极窄只剩图标——即“不够只剩一字／emoji＋颜色背景”
// （纯 CSS，无 JS 测量）。
// 紧凑态（compact）：圆形 Tag，只渲染图标段＋组颜色背景，由行型静态决定
// （单行行用紧凑态），不做 JS 宽度测量。只展示不可点。
// 行为见 docs/specs/task-group-emoji-and-row-tag.md。
export function TaskGroupTag({
  group,
  compact = false,
}: {
  group: TaskGroupTagInfo;
  compact?: boolean;
}) {
  const icon = group.emoji ?? firstGraphemeOf(group.title);
  const fullLabel = group.emoji ? `${group.emoji} ${group.title}` : group.title;
  if (compact) {
    return (
      <Badge
        variant="secondary"
        data-task-group-tag={group.id}
        title={fullLabel}
        aria-label={fullLabel}
        className={cn(
          // 圆 26px；圆整体向上 1px：父级标题行盒是 h-6（24px），26px 圆实测渲染偏下，
          // 用户拍板上移 1px 回到视觉居中（此前给字形加位移是修反了方向——
          // 该动的是圆，不是字形）。图片 glyph 自身不再做位移。
          "flex size-[26px] shrink-0 items-center justify-center rounded-full p-0 leading-none -translate-y-px",
          TASK_GROUP_COLOR_CLASS[group.color],
        )}
      >
        {group.emoji ? (
          <EmojiGlyph emoji={group.emoji} size={16} />
        ) : (
          <span aria-hidden="true" className="text-[15px] leading-none">
            {icon}
          </span>
        )}
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      data-task-group-tag={group.id}
      title={fullLabel}
      aria-label={fullLabel}
      className={cn("max-w-36 gap-1 pl-1 pr-2", TASK_GROUP_COLOR_CLASS[group.color])}
    >
      {/* emoji 用固定 16px 本地图片；无 emoji 的首字保留 15px 文本（与 pill 的
          20px 高度匹配）。图片自身已带透明边距，不需要再校准 emoji 基线位移。 */}
      {group.emoji ? (
        <EmojiGlyph emoji={group.emoji} size={16} className="shrink-0" />
      ) : (
        <span aria-hidden="true" className="shrink-0 text-[15px] leading-none">
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{group.title}</span>
    </Badge>
  );
}
