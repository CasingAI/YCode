// 时间线内容列的宽度类：占位块、隐藏测量层、真实虚拟行列必须共用同一份来源。
//
// 为什么单独抽出来：隐藏测量层量出的高度只有在宽度与真实列一致时才成立——宽度不同
// 则文字换行不同，量出的高度是错的。错的真高度比估值更糟：它会让后续真实渲染产生
// 一次真实的重新测量，而那正是本方案要消除的 delta 来源。
//
// 三处各写一遍类名字符串，漂移只是时间问题；收敛到这里就不可能各写各的。

import { cn } from "@/components/lib/utils.js";

export interface TimelineContentColumnClassInput {
  /** 列宽档位（响应式 max-w 等）。 */
  contentWidthClassName: string | undefined;
  /** 摘要面板内联偏移。仅宽屏面板存在。 */
  summaryPanelInlineOffsetClassName: string | undefined;
  /** 调用方自己的布局类（定位、收缩、过渡等）。 */
  base: string;
}

/** 拼出一个「必须与真实内容列等宽」的块的类名。 */
export function timelineContentColumnClass(input: TimelineContentColumnClassInput): string {
  return cn(input.base, input.contentWidthClassName, input.summaryPanelInlineOffsetClassName);
}
