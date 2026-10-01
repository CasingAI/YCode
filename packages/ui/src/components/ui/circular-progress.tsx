import type { CSSProperties } from "react";
import { cn } from "../lib/utils.js";

/**
 * 圆形进度环：轨道 + 进度弧两层同心圆，供「当前 Todo 走到哪了」这类收起态摘要使用。
 *
 * 仓库里既有的 `Progress` 是横向条，`RosterMeter` 是横向量条，都塞不进 16px 的圆里，
 * 所以圆环自成一个组件而不是横向条的变体。
 *
 * 弧长按 `percent` 换算成 `stroke-dasharray`，起点旋到 12 点方向（`rotate(-90)`），
 * 所以 0% 是一枚空轨道、100% 是一枚满环。
 *
 * **刻意不做旋转动画**：使用它的胶囊左侧已经是静态箭头（`todo.tsx` 明确选了静态箭头以免与
 * 加载动画混淆），右边再叠一个转圈会把「Todo 在推进」读成「有东西在加载」。
 *
 * 颜色用语义 token：轨道 `--color-border`，进度弧 `--color-foreground`。不借用 success /
 * warning / destructive——这三色在进度语境里分别属于「已完成项」「运行中」「失败」，把
 * 完成比例画成 success 会让一条待办看起来已结算。
 *
 * 角色是 `role="img"` 而非 `progressbar`：它是按钮型胶囊里的一枚静态图示，胶囊本身已有
 * `aria-label`，内部再挂一个可交互控件角色会让读屏多报一层。
 */
export const CIRCULAR_PROGRESS_VIEW_BOX = 16;
/** 描边半径（`viewBox` 16、描边 1.5，半径 6.75 恰好把描边内缘落在 6px，外缘落在 7.5px，圆心居中）。 */
export const CIRCULAR_PROGRESS_RADIUS = 6.75;
/** 满环弧长 `2πr`，导出供单测断言换算而不是重复一遍魔数。 */
export const CIRCULAR_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * CIRCULAR_PROGRESS_RADIUS;

function CircularProgress({
  className,
  label,
  size = 16,
  value,
}: {
  /** 已本地化的无障碍标签与 title，读出完成数与百分比。 */
  label: string;
  /** 0–100；越界值被 clamp，不抛错也不产生反向弧。 */
  value: number;
  /** 像素直径；缺省 16（`size-4` 图标基线）。 */
  size?: number;
  className?: string;
}) {
  const percent = Math.min(Math.max(value, 0), 100);
  // 0% 时整层弧不画：`stroke-linecap="round"` 会把 0 弧长渲染成一个圆点，
  // 读起来像「已完成 1 项」。此刻只剩空轨道，才是「还没开始」的诚实形状。
  const started = percent > 0;
  const arc = (percent / 100) * CIRCULAR_PROGRESS_CIRCUMFERENCE;
  return (
    <svg
      aria-label={label}
      className={cn("shrink-0 text-foreground", className)}
      data-testid="circular-progress"
      height={size}
      role="img"
      style={{ "--cp-arc": arc } as CSSProperties}
      viewBox={`0 0 ${CIRCULAR_PROGRESS_VIEW_BOX} ${CIRCULAR_PROGRESS_VIEW_BOX}`}
      width={size}
    >
      {/* 悬停说明走 SVG 原生 <title>（React 的 SVGProps 不接受 title 属性）。 */}
      <title>{label}</title>
      <circle
        className="stroke-[var(--color-border)]"
        cx={CIRCULAR_PROGRESS_VIEW_BOX / 2}
        cy={CIRCULAR_PROGRESS_VIEW_BOX / 2}
        fill="none"
        r={CIRCULAR_PROGRESS_RADIUS}
        strokeWidth={1.5}
      />
      {started ? (
        <circle
          className="stroke-current"
          cx={CIRCULAR_PROGRESS_VIEW_BOX / 2}
          cy={CIRCULAR_PROGRESS_VIEW_BOX / 2}
          fill="none"
          r={CIRCULAR_PROGRESS_RADIUS}
          strokeDasharray={`var(--cp-arc) ${CIRCULAR_PROGRESS_CIRCUMFERENCE}`}
          strokeLinecap="round"
          strokeWidth={1.5}
          // 起点旋到 12 点方向：SVG 的圆弧从 3 点方向起画。
          transform={`rotate(-90 ${CIRCULAR_PROGRESS_VIEW_BOX / 2} ${CIRCULAR_PROGRESS_VIEW_BOX / 2})`}
        />
      ) : null}
    </svg>
  );
}

export { CircularProgress };
