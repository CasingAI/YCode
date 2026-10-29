import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { filesBufferTabTitle } from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 外部修改 / 删除提示条。纯展示组件：只读取 `buffer.externalChange`，
 * 不修改正文与编辑基准；重新加载必须由 controller 先做脏草稿确认。
 */
export function FilesEditorExternalChangeBanner({
  buffer,
  onReload,
  onKeep,
}: {
  buffer?: FilesBuffer;
  onReload: () => void;
  onKeep?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (!buffer || buffer.kind === "preview") return null;
  const change = buffer.externalChange;
  if (!change) return null;
  const name = filesBufferTabTitle(buffer);
  const deleted = change.kind === "deleted";

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-ui-sm text-foreground"
      data-files-external-change={change.kind}
    >
      <span className="min-w-0 flex-1 truncate">
        {intl.formatMessage(
          {
            id: deleted
              ? "filesWorkbench.externalChange.deleted"
              : "filesWorkbench.externalChange.changed",
          },
          { name },
        )}
      </span>
      {!deleted && (
        <Button type="button" size="sm" variant="ghost" onClick={onReload}>
          {intl.formatMessage({ id: "filesWorkbench.externalChange.reload" })}
        </Button>
      )}
      {onKeep && (
        <Button type="button" size="sm" variant="ghost" onClick={onKeep}>
          {intl.formatMessage({ id: "filesWorkbench.externalChange.keep" })}
        </Button>
      )}
    </div>
  );
}
