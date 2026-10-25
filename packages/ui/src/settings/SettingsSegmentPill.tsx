import { cn } from "@/components/lib/utils.js";

/**
 * 设置页共用的 pill 分段按钮：同一层级下（插件商店公开/个人、使用统计、存储分区）
 * 复用这一种视觉，避免出现多套「看起来像 tab」的控件。
 */
export function SettingsSegmentPill({
  active,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        active
          ? "bg-selected text-foreground"
          : "text-foreground-subtle hover:bg-hover hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
