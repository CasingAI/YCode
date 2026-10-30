import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ButtonGroup } from "@/components/ui/button-group.js";
import { cn } from "@/components/lib/utils.js";
import type { FilesEditorMarkdownViewMode } from "@/files-workbench/filesEditorLayout.js";

const MODES = [
  {
    mode: "source",
    labelId: "codeViewer.markdownMode",
    ariaLabelId: "codeViewer.markdownSource",
  },
  {
    mode: "preview",
    labelId: "codeViewer.markdownPreview",
    ariaLabelId: "codeViewer.markdownPreview",
  },
] as const;

/**
 * 标签条与正文之间的轻量 Markdown 文档 Header。
 *
 * 只展示活动 view 的源码 / 预览模式并上报切换，模式状态仍由 layout 独占。
 * 独立占一行，不悬浮覆盖正文，也不占用文件标签条的宽度。
 */
export function FilesMarkdownDocumentHeader({
  mode,
  onChange,
}: {
  mode: FilesEditorMarkdownViewMode;
  onChange: (mode: FilesEditorMarkdownViewMode) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-files-markdown-header=""
      className="flex h-8 shrink-0 items-center border-b border-border bg-background px-2 select-none [app-region:no-drag]"
    >
      <ButtonGroup
        data-files-markdown-mode-switch=""
        aria-label={intl.formatMessage({ id: "codeViewer.markdownMode" })}
        className="shrink-0"
      >
        {MODES.map((item) => {
          const pressed = mode === item.mode;
          return (
            <Button
              key={item.mode}
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={pressed}
              aria-label={intl.formatMessage({ id: item.ariaLabelId })}
              data-files-markdown-mode={item.mode}
              className={cn(
                "px-2 text-ui-sm",
                pressed ? "bg-selected text-foreground" : "text-foreground-subtle",
              )}
              onClick={() => {
                if (!pressed) onChange(item.mode);
              }}
            >
              {intl.formatMessage({ id: item.labelId })}
            </Button>
          );
        })}
      </ButtonGroup>
    </div>
  );
}
