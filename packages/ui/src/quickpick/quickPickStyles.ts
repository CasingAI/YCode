import { cn } from "@/components/lib/utils.js";

const quickPickDialogClassName =
  "top-1/2 max-w-lg -translate-y-1/2 overflow-hidden rounded-2xl! border-popover-border bg-popover p-0 shadow-md";

export const quickPickCommandClassName = "rounded-2xl bg-popover p-0.5 text-foreground";

const quickPickListClassName = "max-h-[min(460px,64vh)] py-0.5";

export const quickPickItemClassName = "min-h-8 items-center rounded-xl px-2.5 text-ui-base";

export const quickPickShortcutPillClassName =
  "inline-flex h-4 min-w-7 items-center justify-center rounded-sm bg-surface px-1 py-0 font-sans text-ui-base leading-none tracking-normal text-foreground-subtle";

export const quickPickMetadataClassName =
  "max-w-[45%] truncate font-sans text-ui-base leading-none tracking-normal text-foreground-subtle";

/**
 * 顶部居中的搜索浮层外壳样式：命令中心与搜索中心共用。
 *
 * Linux 桌面端的通用 DialogContent 会给居中弹窗补偿自绘标题栏高度，
 * 顶部浮层必须在 Linux variant 下重新声明 top，否则平台补偿会覆盖
 * top-16/sm:top-20，导致弹层掉到窗口中部。
 */
export const quickPickTopDialogClassName = cn(
  quickPickDialogClassName,
  "top-16 max-h-[calc(100dvh-4.5rem)] -translate-y-0 sm:top-20 sm:max-h-[calc(100dvh-6rem)]",
  "platform-linux-desktop:top-16 sm:platform-linux-desktop:top-20",
);

export const quickPickTopListClassName = cn(
  quickPickListClassName,
  "max-h-[min(440px,calc(100dvh-15rem))]",
);
