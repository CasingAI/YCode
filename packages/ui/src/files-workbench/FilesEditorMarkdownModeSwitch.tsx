import { Code, Eye } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ButtonGroup } from "@/components/ui/button-group.js";
import { cn } from "@/components/lib/utils.js";
import type { FilesEditorMarkdownViewMode } from "@/files-workbench/filesEditorLayout.js";

const MODES = [
  { mode: "source", labelId: "codeViewer.markdownSource", Icon: Code },
  { mode: "preview", labelId: "codeViewer.markdownPreview", Icon: Eye },
] as const;

/**
 * 标签条右侧的 Markdown「源码 | 预览」分段控件。
 *
 * 只负责展示当前 view 的模式并上报切换；模式状态由 layout 独占。
 * 窄组用图标节省宽度，无障碍名称与悬停提示仍保留完整文字。
 */
export function FilesEditorMarkdownModeSwitch({
  mode,
  onChange,
  compact = false,
}: {
  mode: FilesEditorMarkdownViewMode;
  onChange: (mode: FilesEditorMarkdownViewMode) => void;
  /** 窄组图标模式；由标签条按组容器宽度决定。 */
  compact?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <ButtonGroup
      data-files-markdown-mode-switch=""
      data-files-markdown-mode-compact={compact ? "" : undefined}
      aria-label={intl.formatMessage({ id: "codeViewer.markdownMode" })}
      className="shrink-0"
    >
      {MODES.map((item) => {
        const pressed = mode === item.mode;
        const label = intl.formatMessage({ id: item.labelId });
        return (
          <Button
            key={item.mode}
            type="button"
            size={compact ? "icon-sm" : "sm"}
            variant="ghost"
            aria-pressed={pressed}
            aria-label={compact ? label : undefined}
            title={compact ? label : undefined}
            data-files-markdown-mode={item.mode}
            className={cn(
              !compact && "px-2 text-ui-sm",
              pressed ? "bg-selected text-foreground" : "text-foreground-subtle",
            )}
            onClick={() => {
              if (!pressed) onChange(item.mode);
            }}
          >
            {compact ? <item.Icon aria-hidden="true" /> : label}
          </Button>
        );
      })}
    </ButtonGroup>
  );
}
