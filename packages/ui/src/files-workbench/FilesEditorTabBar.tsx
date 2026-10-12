import { X } from "lucide-react";
import { TID_FILES_EDITOR_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  filesBufferTabTitle,
  filesBufferTabTooltip,
  isFilesBufferDirty,
  isFilesPreviewTab,
  needsFilesWorkspaceDisambiguation,
} from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

export function FilesEditorTabBar({
  buffers,
  activeId,
  onActivate,
  onKeepOpen,
  onClose,
  onCloseOthers,
  onCreateUntitled,
}: {
  buffers: readonly FilesBuffer[];
  activeId?: string;
  onActivate: (id: string) => void;
  onKeepOpen: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCreateUntitled?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "filesWorkbench.tabList" })}
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-background-alt select-none [app-region:no-drag]"
    >
      {buffers.map((buffer) => {
        const selected = buffer.id === activeId;
        const previewTab = isFilesPreviewTab(buffer);
        const dirty = isFilesBufferDirty(buffer);
        const disambiguate = needsFilesWorkspaceDisambiguation(buffers, buffer);
        const icon = resolveFileDisplayDescriptor(buffer.path ?? buffer.title);
        const title = filesBufferTabTitle(buffer);
        const closeLabel = intl.formatMessage({ id: "filesWorkbench.closeTab" }, { name: title });
        return (
          <ContextMenu key={buffer.id}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                tabIndex={0}
                aria-selected={selected}
                data-testid={testId(TID_FILES_EDITOR_TAB, buffer.id)}
                title={filesBufferTabTooltip(buffer)}
                className={cn(
                  "group relative flex max-w-52 min-w-28 shrink-0 cursor-default items-center gap-1.5 border-r border-border px-2.5 text-ui-sm",
                  previewTab && "italic",
                  selected
                    ? "bg-background text-foreground"
                    : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                )}
                onClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  onActivate(buffer.id);
                }}
                onDoubleClick={() => onKeepOpen(buffer.id)}
                onAuxClick={(event) => {
                  if (event.button !== 1) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  onClose(buffer.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onActivate(buffer.id);
                  }
                }}
              >
                {selected ? (
                  <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-brand" />
                ) : null}
                <FileDisplayIcon src={icon.fileIconSrc} size={16} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {title}
                  {disambiguate ? ` — ${filesBufferTabTooltip(buffer).split(" — ").at(-1)}` : ""}
                </span>
                <button
                  type="button"
                  aria-label={closeLabel}
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-surface-hover",
                    selected || dirty
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(buffer.id);
                  }}
                >
                  {dirty ? (
                    <span className="relative flex size-3 items-center justify-center">
                      <span className="size-1.5 rounded-full bg-foreground group-hover:hidden group-focus-within:hidden" />
                      <X className="absolute hidden size-3 group-hover:block group-focus-within:block" />
                    </span>
                  ) : (
                    <X className="size-3" />
                  )}
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-44">
              <ContextMenuItem disabled={!previewTab} onSelect={() => onKeepOpen(buffer.id)}>
                {intl.formatMessage({ id: "filesWorkbench.keepOpen" })}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onClose(buffer.id)}>
                {intl.formatMessage({ id: "filesWorkbench.closeTabMenu" })}
              </ContextMenuItem>
              <ContextMenuItem disabled={buffers.length < 2} onSelect={() => onCloseOthers(buffer.id)}>
                {intl.formatMessage({ id: "filesWorkbench.closeOtherTabs" })}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      <div className="min-w-8 flex-1" onDoubleClick={() => onCreateUntitled?.()} />
    </div>
  );
}
