import { firstGraphemeOf } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { TASK_GROUP_COLOR_CLASS } from "@/workspace-grouped-tasks/types.js";
import type { TaskGroupTagInfo } from "@/hooks/useTaskGroupTagMap.js";

// 任务行所属分组 Tag。
// 完整态（compact 缺省）：[图标段 ＋ 文本段] pill。图标段＝emoji（有）或标题首
// grapheme（无），带组颜色背景，shrink-0 永不压缩；文本段＝组标题 truncate。
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
          // 尺寸 26px/字号 22px 是用户 DevTools 实测调优值（20px 圆里 emoji 偏小）。
          // 圆整体向上 1px：父级标题行盒是 h-6（24px），26px 圆实测渲染偏下，
          // 用户拍板上移 1px 回到视觉居中（此前给字形加位移是修反了方向——
          // 该动的是圆，不是字形）。
          "flex size-[26px] shrink-0 items-center justify-center rounded-full p-0 text-[22px] leading-none -translate-y-px",
          TASK_GROUP_COLOR_CLASS[group.color],
        )}
      >
        <span
          aria-hidden="true"
          // 曾按 headless Chrome（DPR1）实验给 emoji 加 translateY(1px) 校准「偏上」，
          // 用户 Retina 真实环境实测：原本是正的，位移反而弄歪——字体度量渲染随
          // DPR/平台变化，headless 单环境实验结论不可迁移。保持无位移。
          className="leading-none"
        >
          {icon}
        </span>
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
      {/* 图标段显式 15px：继承 Badge 的 text-ui-xs 时 emoji 位图字形只有 ~11px，几乎不可读
          （用户实测反馈「火箭太小」）；15px 与 pill 的 20px 高度匹配，且大于相邻文本段，
          符合「emoji 即图标」的观感。不校准基线位移——与文本段并排时保持行内基线对齐。 */}
      <span aria-hidden="true" className="shrink-0 text-[15px] leading-none">
        {icon}
      </span>
      <span className="min-w-0 truncate">{group.title}</span>
    </Badge>
  );
}
