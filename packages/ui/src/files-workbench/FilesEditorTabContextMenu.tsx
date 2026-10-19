import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { FilesEditorSplitEdge } from "@/files-workbench/filesEditorLayout.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

export function FilesEditorTabContextMenu({
  viewId,
  buffer,
  previewTab,
  groupId,
  canCloseOthers,
  canCloseToRight,
  canCloseSaved,
  canRevealInFileTree,
  onKeepOpen,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseSaved,
  onCloseAll,
  onCopyPath,
  onRevealInFileTree,
  onSplit,
}: {
  viewId: string;
  buffer: FilesBuffer;
  previewTab: boolean;
  groupId: string;
  canCloseOthers: boolean;
  canCloseToRight: boolean;
  canCloseSaved: boolean;
  canRevealInFileTree: boolean;
  onKeepOpen: (bufferId: string) => void;
  onClose: (bufferId: string, viewId: string) => void;
  onCloseOthers: (bufferId: string, viewId: string, groupId: string) => void;
  onCloseToRight: (viewId: string, groupId: string) => void;
  onCloseSaved: () => void;
  onCloseAll: () => void;
  onCopyPath: (buffer: FilesBuffer, kind: "absolute" | "relative") => void;
  onRevealInFileTree: (buffer: FilesBuffer) => void;
  onSplit: (viewId: string, groupId: string, edge: FilesEditorSplitEdge) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <ContextMenuContent className="w-56">
      {previewTab ? (
        <>
          <ContextMenuItem onSelect={() => onKeepOpen(buffer.id)}>
            {intl.formatMessage({ id: "filesWorkbench.keepOpen" })}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuItem onSelect={() => onClose(buffer.id, viewId)}>
        {intl.formatMessage({ id: "filesWorkbench.closeTabMenu" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canCloseOthers}
        onSelect={() => onCloseOthers(buffer.id, viewId, groupId)}
      >
        {intl.formatMessage({ id: "filesWorkbench.closeOtherTabs" })}
      </ContextMenuItem>
      <ContextMenuItem disabled={!canCloseToRight} onSelect={() => onCloseToRight(viewId, groupId)}>
        {intl.formatMessage({ id: "filesWorkbench.closeTabsToRight" })}
      </ContextMenuItem>
      <ContextMenuItem disabled={!canCloseSaved} onSelect={onCloseSaved}>
        {intl.formatMessage({ id: "filesWorkbench.closeSavedTabs" })}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCloseAll}>
        {intl.formatMessage({ id: "filesWorkbench.closeAllTabs" })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!buffer.path} onSelect={() => onCopyPath(buffer, "absolute")}>
        {intl.formatMessage({ id: "filesWorkbench.copyPath" })}
      </ContextMenuItem>
      <ContextMenuItem disabled={!buffer.path} onSelect={() => onCopyPath(buffer, "relative")}>
        {intl.formatMessage({ id: "filesWorkbench.copyRelativePath" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!buffer.path || !canRevealInFileTree}
        onSelect={() => onRevealInFileTree(buffer)}
      >
        {intl.formatMessage({ id: "filesWorkbench.revealInFileTree" })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onSplit(viewId, groupId, "right")}>
        {intl.formatMessage({ id: "filesWorkbench.splitRight" })}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onSplit(viewId, groupId, "bottom")}>
        {intl.formatMessage({ id: "filesWorkbench.splitDown" })}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
