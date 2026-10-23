import { memo } from "react";
import { X } from "lucide-react";
import { TID_FILES_EDITOR_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { FilesEditorTabContextMenu } from "@/files-workbench/FilesEditorTabContextMenu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  filesBufferTabTitle,
  filesBufferTabTooltip,
  isFilesBufferDirty,
  isFilesPreviewTab,
} from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorSplitEdge } from "@/files-workbench/filesEditorLayout.js";
import { filesEditorTabFlex } from "@/files-workbench/filesEditorTabSizing.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import { FILES_EDITOR_VIEW_DRAG_MIME } from "@/files-workbench/filesEditorDragTypes.js";
import { useFilesEditorTabAnimation } from "@/files-workbench/filesEditorTabAnimation.js";

export interface FilesEditorTabItemProps {
  viewId: string;
  buffer: FilesBuffer;
  selected: boolean;
  isGroupFocused?: boolean;
  disambiguate: boolean;
  canCloseOthers: boolean;
  canCloseToRight: boolean;
  canCloseSaved: boolean;
  canRevealInFileTree: boolean;
  crowded: boolean;
  hovered: boolean;
  entering: boolean;
  exiting: boolean;
  groupId: string;
  index: number;
  onActivate: (viewId: string) => void;
  onKeepOpen: (bufferId: string) => void;
  onClose: (bufferId: string, viewId: string) => void;
  onCloseOthers: (bufferId: string, viewId: string, groupId: string) => void;
  onCloseToRight: (viewId: string, groupId: string) => void;
  onCloseSaved: () => void;
  onCloseAll: () => void;
  onCopyPath: (buffer: FilesBuffer, kind: "absolute" | "relative") => void;
  onRevealInFileTree: (buffer: FilesBuffer) => void;
  onSplit: (viewId: string, groupId: string, edge: FilesEditorSplitEdge) => void;
  onMoveView: (viewId: string, groupId: string, targetIndex?: number) => void;
  onHover: (viewId?: string) => void;
  onEnterComplete: (viewId: string) => void;
  onExitComplete: (viewId: string) => void;
}

// Memoized tabs avoid redoing icon/title/tooltip work across hundreds of restored files.
export const FilesEditorTabItem = memo(function FilesEditorTabItem({
  viewId,
  buffer,
  selected,
  isGroupFocused = true,
  disambiguate,
  canCloseOthers,
  canCloseToRight,
  canCloseSaved,
  canRevealInFileTree,
  crowded,
  hovered,
  entering,
  exiting,
  groupId,
  index,
  onActivate,
  onKeepOpen,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseSaved,
  onCloseAll,
  onCopyPath,
  onRevealInFileTree,
  onSplit,
  onMoveView,
  onHover,
  onEnterComplete,
  onExitComplete,
}: FilesEditorTabItemProps) {
  const { tabRef, collapsed } = useFilesEditorTabAnimation(
    viewId,
    entering,
    exiting,
    onEnterComplete,
    onExitComplete,
  );
  const { intl } = useZCodeIntl();
  const previewTab = isFilesPreviewTab(buffer);
  const dirty = isFilesBufferDirty(buffer);
  const icon = resolveFileDisplayDescriptor(buffer.path ?? buffer.title);
  const title = filesBufferTabTitle(buffer);
  const closeLabel = intl.formatMessage({ id: "filesWorkbench.closeTab" }, { name: title });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={tabRef}
          role="tab"
          tabIndex={exiting ? -1 : 0}
          draggable={!exiting}
          aria-selected={selected}
          aria-hidden={exiting || undefined}
          data-testid={testId(TID_FILES_EDITOR_TAB, viewId)}
          data-editor-view-id={viewId}
          title={filesBufferTabTooltip(buffer)}
          style={{
            flex: collapsed ? "0 1 0%" : filesEditorTabFlex(crowded, selected, hovered),
            minWidth: collapsed ? 0 : undefined,
            opacity: collapsed ? 0 : 1,
          }}
          className={cn(
            "group relative flex min-w-0 flex-[1_1_0%] cursor-default items-center gap-1.5 overflow-hidden border-r border-border px-2.5 text-ui-sm transition-[flex-grow,flex-basis,opacity] duration-200 motion-reduce:transition-none",
            exiting ? "pointer-events-none ease-in" : "ease-out",
            previewTab && "italic",
            selected
              ? isGroupFocused
                ? "bg-background text-foreground"
                : "bg-background text-foreground-subtle"
              : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
          )}
          onMouseEnter={() => onHover(viewId)}
          onClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onActivate(viewId);
          }}
          onDoubleClick={() => onKeepOpen(buffer.id)}
          onAuxClick={(event) => {
            if (event.button !== 1) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onClose(buffer.id, viewId);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivate(viewId);
            }
          }}
          onDragStart={(event) => {
            if (exiting) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.setData(FILES_EDITOR_VIEW_DRAG_MIME, viewId);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes(FILES_EDITOR_VIEW_DRAG_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            const draggedViewId = event.dataTransfer.getData(FILES_EDITOR_VIEW_DRAG_MIME);
            if (!draggedViewId) return;
            if ((event.target as HTMLElement).closest("button")) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const insertAfter = event.clientX >= rect.left + rect.width / 2;
            onMoveView(draggedViewId, groupId, index + (insertAfter ? 1 : 0));
          }}
        >
          {selected && isGroupFocused ? (
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
              onClose(buffer.id, viewId);
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
      <FilesEditorTabContextMenu
        viewId={viewId}
        buffer={buffer}
        previewTab={previewTab}
        groupId={groupId}
        canCloseOthers={canCloseOthers}
        canCloseToRight={canCloseToRight}
        canCloseSaved={canCloseSaved}
        canRevealInFileTree={canRevealInFileTree}
        onKeepOpen={onKeepOpen}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseToRight={onCloseToRight}
        onCloseSaved={onCloseSaved}
        onCloseAll={onCloseAll}
        onCopyPath={onCopyPath}
        onRevealInFileTree={onRevealInFileTree}
        onSplit={onSplit}
      />
    </ContextMenu>
  );
});
