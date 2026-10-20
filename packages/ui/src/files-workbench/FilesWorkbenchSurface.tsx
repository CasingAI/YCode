import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { TID_FILES_WORKBENCH } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { filesBufferTabTitle, findFilesBuffer } from "@/files-workbench/filesEditorModel.js";
import type {
  FilesEditorLayoutNode,
  FilesEditorSplitEdge,
} from "@/files-workbench/filesEditorLayout.js";
import type {
  FilesMonacoOpenPath,
  FilesMonacoRevealPosition,
} from "@/files-workbench/filesEditorTypes.js";
import { FilesEditorGroupPane } from "@/files-workbench/FilesEditorGroupPane.js";
import {
  FilesConflictDialog,
  FilesDirtyCloseDialog,
} from "@/files-workbench/FilesWorkbenchDialogs.js";
import { FilesSaveAsDialog } from "@/files-workbench/FilesSaveAsDialog.js";
import { filesExplorerWorkspaceOptions } from "@/files-workbench/filesExplorerWorkspace.js";
import { useFilesWorkbenchController } from "@/files-workbench/useFilesWorkbenchController.js";
import { useFilesEditorMenuCommands } from "@/files-workbench/useFilesEditorMenuCommands.js";
import { useFilesEditorUntitled } from "@/files-workbench/useFilesEditorUntitled.js";
import { useFilesEditorTabContextActions } from "@/files-workbench/useFilesEditorTabContextActions.js";
import { filesActiveTextBuffer } from "@/files-workbench/filesActiveTextBuffer.js";
import { useFilesMonacoTypescriptWorkspaceSync } from "@/files-workbench/useFilesMonacoTypescriptWorkspaceSync.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";

export function FilesWorkbenchSurface({
  isActiveView,
  isDesktop = false,
}: {
  isActiveView: boolean;
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const store = useFilesEditorStoreApi();
  const tabStoreApi = useTabStoreApi();
  const buffers = useFilesEditorStore((state) => state.buffers);
  const activeId = useFilesEditorStore((state) => state.activeId);
  const openIds = useFilesEditorStore((state) => state.openIds);
  const layout = useFilesEditorStore((state) => state.layout);
  const pendingSaveDirectory = useFilesEditorStore((state) => state.pendingSaveDirectory);
  const explorerWorkspaceKey = useFilesEditorStore((state) => state.explorerWorkspaceKey);
  const editorFocusRequest = useFilesEditorStore((state) => state.editorFocusRequest);
  const workspaceTabs = useTabStore(useShallow((state) => state.tabs.filter(isWorkspaceTab)));
  const [hasEnteredFiles, setHasEnteredFiles] = useState(isActiveView);
  const [revealPosition, setRevealPosition] = useState<FilesMonacoRevealPosition>();
  const controller = useFilesWorkbenchController(hasEnteredFiles);
  const resizeCleanupRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (isActiveView) setHasEnteredFiles(true);
  }, [isActiveView]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const openBuffers = useMemo(
    () =>
      openIds.flatMap((id) => {
        const buffer = findFilesBuffer({ buffers, openIds, untitledSerial: 1 }, id);
        return buffer ? [buffer] : [];
      }),
    [buffers, openIds],
  );
  const typescriptEntries = useMemo(
    () =>
      openBuffers.flatMap((buffer) =>
        buffer.kind === "text" && buffer.path && !buffer.untitled && buffer.loadState === undefined
          ? [
              {
                bufferId: buffer.id,
                path: buffer.path,
                text: buffer.text,
                workspace: buffer.workspace,
              },
            ]
          : [],
      ),
    [openBuffers],
  );
  const activeWorkspace = buffers.find((buffer) => buffer.id === activeId)?.workspace;
  const resolveServices = controller.resolveServices;
  useFilesMonacoTypescriptWorkspaceSync({
    enabled: isActiveView && hasEnteredFiles,
    entries: typescriptEntries,
    activeWorkspace,
    activeBufferId: activeId,
    resolveServices,
  });

  const loadRestoredTextFile = controller.loadRestoredTextFile;
  const persist = controller.persist;
  const saveActiveFile = controller.saveActiveFile;
  const saveActiveFileAs = controller.saveActiveFileAs;
  const saveAllFiles = controller.saveAllFiles;
  const closeActiveEditorView = controller.closeActiveEditorView;
  const closeView = controller.closeView;
  const closeOtherViews = controller.closeOtherViews;
  const closeViewsToRight = controller.closeViewsToRight;
  const closeSavedViews = controller.closeSavedViews;
  const closeAllViews = controller.closeAllViews;
  const dirtyCloseBuffer = controller.dirtyCloseBufferId
    ? findFilesBuffer({ buffers, openIds, untitledSerial: 1 }, controller.dirtyCloseBufferId)
    : undefined;
  const saveAsBuffer = controller.saveAsBufferId
    ? filesActiveTextBuffer(buffers, controller.saveAsBufferId)
    : undefined;

  const explorerOptions = useMemo(
    () => filesExplorerWorkspaceOptions(workspaceTabs),
    [workspaceTabs],
  );
  const openFilesViewCallback = useCallback(() => {
    tabStoreApi.getState().openFilesTab();
  }, [tabStoreApi]);
  const { onCreateUntitled } = useFilesEditorUntitled({
    store,
    explorerOptions,
    explorerWorkspaceKey,
    persist,
    // 菜单的「新建文件」在任务 / 设置界面也能用，建完要切到文件界面让标签可见。
    openFilesView: openFilesViewCallback,
  });

  const onActivate = useCallback(
    (viewId: string) => store.getState().activateView(viewId),
    [store],
  );
  const onKeepOpen = useCallback(
    (id: string) => {
      const buffer = findFilesBuffer(store.getState(), id);
      if (!buffer) return;
      store.getState().openBuffer(buffer, "keep");
      persist();
    },
    [persist, store],
  );
  const onClose = useCallback(
    (bufferId: string, viewId: string) => void closeView(bufferId, viewId),
    [closeView],
  );
  const onCloseOthers = useCallback(
    (keepBufferId: string, keepViewId: string, groupId: string) =>
      void closeOtherViews(keepBufferId, keepViewId, groupId),
    [closeOtherViews],
  );
  const {
    hasSavedBuffers,
    onCloseToRight,
    onCloseSaved,
    onCloseAll,
    onCopyPath,
    canRevealInFileTree,
    onRevealInFileTree,
  } = useFilesEditorTabContextActions({
    store,
    openBuffers,
    explorerOptions,
    closeViewsToRight,
    closeSavedViews,
    closeAllViews,
  });
  const onMoveView = useCallback(
    (viewId: string, groupId: string, targetIndex?: number) =>
      store.getState().moveViewToGroup(viewId, groupId, targetIndex),
    [store],
  );
  const onSplit = useCallback(
    (viewId: string, groupId: string, edge: FilesEditorSplitEdge, mode?: "move" | "copy") =>
      store.getState().splitViewToEdge(viewId, groupId, edge, mode),
    [store],
  );
  const onChange = useCallback(
    (id: string, text: string) => {
      const current = findFilesBuffer(store.getState(), id);
      if (!current || current.kind !== "text" || current.text === text) return;
      store.getState().updateText(id, text);
      persist();
    },
    [persist, store],
  );

  // 标签栏保存按钮：与菜单、快捷键共用同一条写盘路径。
  const onSave = controller.saveBufferById;

  // 桌面菜单、快捷键与 ⌘W 的接线集中在独立 hook，界面本体只留渲染。
  const { onEditorHandleChange } = useFilesEditorMenuCommands({
    isActiveView,
    focusedGroupId: layout.focusedGroupId,
    saveActiveFile,
    saveActiveFileAs,
    saveAllFiles,
    onCreateUntitled,
    closeActiveEditorView,
  });
  const onFocusGroup = useCallback(
    (groupId: string) => store.getState().focusGroup(groupId),
    [store],
  );
  const onOpenMonacoPath = useCallback<FilesMonacoOpenPath>(
    (workspace, path, position) => {
      setRevealPosition(position ? { workspace, path, ...position } : undefined);
      store.getState().requestOpenPath({ workspace, path });
      tabStoreApi.getState().openFilesTab();
      return true;
    },
    [store, tabStoreApi],
  );
  const onRevealPositionApplied = useCallback((path: string) => {
    setRevealPosition((current) => (current?.path === path ? undefined : current));
  }, []);
  // 聚焦意图被目标编辑器消费后清掉：它是一次性请求，不该在后续打开里再生效。
  const onFocusApplied = useCallback(
    (requestId: number) => {
      store.getState().clearEditorFocusRequest(requestId);
    },
    [store],
  );

  const beginResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    node: Extract<FilesEditorLayoutNode, { type: "branch" }>,
  ) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const parent = event.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const horizontal = node.direction === "horizontal";
    const dimension = horizontal ? rect.width : rect.height;
    if (dimension <= 0) return;
    const startPosition = horizontal ? event.clientX : event.clientY;
    const startRatio = node.ratio;
    const pointerId = event.pointerId;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const position = horizontal ? moveEvent.clientX : moveEvent.clientY;
      store.getState().setBranchRatio(node.id, startRatio + (position - startPosition) / dimension);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = undefined;
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) cleanup();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    resizeCleanupRef.current = cleanup;
  };

  function renderLayoutNode(node: FilesEditorLayoutNode): ReactNode {
    if (node.type === "leaf") {
      const group = layout.groups[node.groupId];
      if (!group) return null;
      return (
        <FilesEditorGroupPane
          key={group.id}
          group={group}
          buffers={openBuffers}
          isActiveView={isActiveView}
          hasEnteredFiles={hasEnteredFiles}
          isFocused={layout.focusedGroupId === group.id}
          loadRestoredTextFile={loadRestoredTextFile}
          onActivate={onActivate}
          onKeepOpen={onKeepOpen}
          onClose={onClose}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
          onCloseSaved={onCloseSaved}
          onCloseAll={onCloseAll}
          canCloseSaved={hasSavedBuffers}
          onCopyPath={onCopyPath}
          onRevealInFileTree={onRevealInFileTree}
          canRevealInFileTree={canRevealInFileTree}
          onMoveView={onMoveView}
          onSplit={onSplit}
          onChange={onChange}
          onOpenPath={onOpenMonacoPath}
          revealPosition={revealPosition}
          onRevealPositionApplied={onRevealPositionApplied}
          focusRequest={editorFocusRequest}
          onFocusApplied={onFocusApplied}
          onCreateUntitled={onCreateUntitled}
          onSave={onSave}
          onFocusGroup={onFocusGroup}
          onEditorHandleChange={onEditorHandleChange}
        />
      );
    }

    const horizontal = node.direction === "horizontal";
    const onResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      const decrement = horizontal ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      const increment = horizontal ? event.key === "ArrowRight" : event.key === "ArrowDown";
      if (!decrement && !increment) return;
      event.preventDefault();
      store.getState().setBranchRatio(node.id, node.ratio + (increment ? 0.02 : -0.02));
    };
    return (
      <div
        key={node.id}
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden",
          horizontal ? "flex-row" : "flex-col",
        )}
        data-editor-split-id={node.id}
      >
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden",
            horizontal ? "min-w-[160px]" : "min-h-[120px]",
          )}
          style={{ flex: `${node.ratio} 1 0px` }}
        >
          {renderLayoutNode(node.children[0])}
        </div>
        <div
          role="separator"
          aria-label={intl.formatMessage({ id: "filesWorkbench.resizeSplit" })}
          aria-orientation={horizontal ? "vertical" : "horizontal"}
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round(node.ratio * 100)}
          tabIndex={0}
          className={cn(
            "z-10 shrink-0 touch-none bg-border/70 transition-colors hover:bg-brand focus-visible:bg-brand focus-visible:outline-none",
            horizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
          )}
          onPointerDown={(event) => beginResize(event, node)}
          onKeyDown={onResizeKeyDown}
        />
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden",
            horizontal ? "min-w-[160px]" : "min-h-[120px]",
          )}
          style={{ flex: `${1 - node.ratio} 1 0px` }}
        >
          {renderLayoutNode(node.children[1])}
        </div>
      </div>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col [app-region:no-drag]"
      data-testid={TID_FILES_WORKBENCH}
      data-files-workbench=""
    >
      {/* 与左栏顶栏、会话 Header 齐高。整层只负责拖窗口，标签条必须在这层下面。 */}
      <div
        aria-hidden="true"
        className={cn("h-12 shrink-0", isDesktop && isActiveView && "[app-region:drag]")}
      />
      <div className="min-h-0 min-w-0 flex-1 [app-region:no-drag]">
        {renderLayoutNode(layout.root)}
      </div>
      <FilesDirtyCloseDialog
        open={Boolean(dirtyCloseBuffer)}
        name={dirtyCloseBuffer ? filesBufferTabTitle(dirtyCloseBuffer) : ""}
        onDecide={(decision) => void controller.handleDirtyCloseDecision(decision)}
      />
      <FilesConflictDialog
        open={Boolean(controller.conflictBuffer)}
        onDecide={(decision) => void controller.handleConflictDecision(decision)}
      />
      <FilesSaveAsDialog
        open={Boolean(saveAsBuffer)}
        defaultDirectory={pendingSaveDirectory ?? saveAsBuffer?.workspace.workspacePath}
        defaultFileName={saveAsBuffer?.title}
        fileService={
          saveAsBuffer ? controller.resolveServices(saveAsBuffer.workspace).fileService : undefined
        }
        onCancel={() => {
          controller.setSaveAsBufferId(undefined);
          controller.cancelPendingClose();
          // 另存为被取消：全部保存就此停止，剩余文件保持未保存。
          controller.stopSaveAll();
        }}
        onConfirm={(path) => {
          if (!saveAsBuffer) return;
          controller.setSaveAsBufferId(undefined);
          void controller.saveTextBuffer(saveAsBuffer, { path, force: true }).then((saved) => {
            if (saved) {
              controller.resumePendingClose();
              void controller.resumeSaveAll();
            } else {
              controller.stopSaveAll();
            }
          });
        }}
      />
    </section>
  );
}
