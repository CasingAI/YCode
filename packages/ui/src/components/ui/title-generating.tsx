import { useEffect, useState } from "react";
import { cn } from "../lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 逐帧轮换的字符帧，抄自 TUI 的 SPINNER_FRAMES
 * （apps/zcode-cli/packages/tui/src/app-motion.tsx）。没有跨包 import 是因为那边
 * 依赖 ink 的 palette；为 10 个字符新建一条 TUI↔UI 依赖不划算。
 *
 * 选盲文单字符而不是递增点号：单字符宽度恒定，放在 truncate 标题槽位里不会
 * 左右跳；`.` → `..` → `...` 会。
 */
const TITLE_GENERATING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 80;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useFrameIndex(animated: boolean): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!animated) return undefined;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % TITLE_GENERATING_FRAMES.length),
      FRAME_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [animated]);
  return index;
}

export interface TitleGeneratingTextProps {
  className?: string;
  /** 无障碍读屏文案；默认用 i18n 的「正在生成标题」。 */
  label?: string;
}

/**
 * 会话标题「正在重新生成」时的占位符，替代标题本体渲染。
 *
 * 纯 JS 帧轮换，没有 CSS 动画、没有渐变、没有骨架屏方块——同字体同字号，
 * 所以标题槽位宽度不变、列表不会因为换行或滚动位置而跳。
 */
export function TitleGeneratingText({ className, label }: TitleGeneratingTextProps) {
  const { intl } = useZCodeIntl();
  const reducedMotion = useReducedMotion();
  const index = useFrameIndex(!reducedMotion);
  const frame = TITLE_GENERATING_FRAMES[index] ?? TITLE_GENERATING_FRAMES[0];
  const text = label ?? intl.formatMessage({ id: "taskList.titleGenerating" });

  return (
    <span
      aria-label={text}
      aria-live="polite"
      className={cn("inline-flex items-center text-foreground-subtle", className)}
      data-zcode-title-generating="true"
      role="status"
    >
      <span aria-hidden="true">{text}</span>
      <span aria-hidden="true">{frame}</span>
    </span>
  );
}
