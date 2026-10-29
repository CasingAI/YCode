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
  FilesExternalChangeReloadDialog,
  FilesLargeTextConflictDialog,
} from "@/files-workbench/FilesWorkbenchDialogs.js";
import { filesExplorerWorkspaceOptions } from "@/files-workbench/filesExplorerWorkspace.js";
import { FilesWorkbenchSaveAsDialog } from "@/files-workbench/FilesWorkbenchSaveAsDialog.js";
import { useFilesWorkbenchController } from "@/files-workbench/useFilesWorkbenchController.js";
import { useFilesEditorMenuCommands } from "@/files-workbench/useFilesEditorMenuCommands.js";
import { useFilesEditorUntitled } from "@/files-workbench/useFilesEditorUntitled.js";
import { useFilesEditorTabContextActions } from "@/files-workbench/useFilesEditorTabContextActions.js";
import { filesActiveSavableBuffer } from "@/files-workbench/filesActiveSavableBuffer.js";
import { FilesLargeTextDraftStatus } from "@/files-workbench/FilesLargeTextDraftStatus.js";
import { FilesWorkbenchToolbar } from "@/files-workbench/FilesWorkbenchToolbar.js";
import { FilesWorkbenchHeader } from "@/files-workbench/FilesWorkbenchHeader.js";
import { FilesWorkbenchWindowControls } from "@/files-workbench/FilesWorkbenchWindowControls.js";
import { useFilesWorkbenchTabChrome } from "@/files-workbench/useFilesWorkbenchTabChrome.js";
import { useFilesMonacoTypescriptWorkspaceSync } from "@/files-workbench/useFilesMonacoTypescriptWorkspaceSync.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";

export function FilesWorkbenchSurface({
  isActiveView,
  isDesktop = false,
  isMacDesktop = false,
}: {
  isActiveView: boolean;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const store = useFilesEditorStoreApi();
  const tabStoreApi = useTabStoreApi();
  const buffers = useFilesEditorStore((state) => state.buffers);
  const activeId = useFilesEditorStore((state) => state.activeId);
  const openIds = useFilesEditorStore((state) => state.openIds);
  const layout = useFilesEditorStore((state) => state.layout);
  const surfaceRef = useRef<HTMLElement | null>(null);
  useFilesWorkbenchTabChrome({ surfaceRef, layoutRoot: layout.root, isDesktop, isActiveView });
  const pendingSaveDirectory = useFilesEditorStore((state) => state.pendingSaveDirectory);
  const explorerWorkspaceKey = useFilesEditorStore((state) => state.explorerWorkspaceKey);
  const editorFocusRequest = useFilesEditorStore((state) => state.editorFocusRequest);
  const workspaceTabs = useTabStore(useShallow((state) => state.tabs.filter(isWorkspaceTab)));
  const [hasEnteredFiles, setHasEnteredFiles] = useState(isActiveView);
  const [revealPosition, setRevealPosition] = useState<FilesMonacoRevealPosition>();
  // 控制器的恢复 / watch 只跟随文件主视图是否激活；进入过文件视图不代表现在可见。
  const controller = useFilesWorkbenchController(hasEnteredFiles, isActiveView);
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

  const persist = controller.persist;
  const closeView = controller.closeView;
  const closeOtherViews = controller.closeOtherViews;
  const dirtyCloseBuffer = controller.dirtyCloseBufferId
    ? findFilesBuffer({ buffers, openIds, untitledSerial: 1 }, controller.dirtyCloseBufferId)
    : undefined;
  const reloadConfirmBuffer = buffers.find(
    (buffer) => buffer.id === controller.reloadConfirmBufferId,
  );
  // 大文件 IndexedDB 草稿状态只做投影：blocked / errors / pending 都可解释，
  // Store 仍是编辑草稿的唯一所有者；组件内部只读快照，不复制 changes 或改写基准。

  const explorerOptions = useMemo(
    () => filesExplorerWorkspaceOptions(workspaceTabs),
    [workspaceTabs],
  );
  const openFilesViewCallback = useCallback(() => {
    tabStoreApi.getState().openFilesTab();
  }, [tabStoreApi]);
  const { onCreateUntitled, untitledWorkspace } = useFilesEditorUntitled({
    store,
    explorerOptions,
    explorerWorkspaceKey,
    persist,
    // 菜单的「新建文件」在任务 / 设置界面也能用，建完要切到文件界面让标签可见。
    openFilesView: openFilesViewCallback,
  });

  const onActivate = store.getState().activateView;
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
    closeViewsToRight: controller.closeViewsToRight,
    closeSavedViews: controller.closeSavedViews,
    closeAllViews: controller.closeAllViews,
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

  // 标签栏保存按钮与标签右键「保存 / 另存为」：与菜单、快捷键共用同一条写盘路径。
  const onSave = controller.saveBufferById;
  const onSaveAs = controller.saveBufferAs;

  // 桌面菜单、快捷键与 ⌘W 的接线集中在独立 hook，界面本体只留渲染。
  const { onEditorHandleChange, onMenuCommand, onCloseEditor, canEdit } =
    useFilesEditorMenuCommands({
      isActiveView,
      focusedGroupId: layout.focusedGroupId,
      activeBufferId: activeId,
      canCreateFile: Boolean(untitledWorkspace),
      saveActiveFile: controller.saveActiveFile,
      saveActiveFileAs: controller.saveActiveFileAs,
      saveAllFiles: controller.saveAllFiles,
      onCreateUntitled,
      closeActiveEditorView: controller.closeActiveEditorView,
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
          loadRestoredTextFile={controller.loadRestoredTextFile}
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
          onSaveAs={onSaveAs}
          onFocusGroup={onFocusGroup}
          onEditorHandleChange={onEditorHandleChange}
          onExternalChangeAction={(bufferId, action) =>
            action === "reload"
              ? controller.requestReloadBuffer(bufferId)
              : controller.dismissExternalChange(bufferId)
          }
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
      ref={surfaceRef}
      className="relative flex h-full min-h-0 min-w-0 flex-col [app-region:no-drag]"
      data-testid={TID_FILES_WORKBENCH}
      data-files-workbench=""
    >
      <FilesWorkbenchHeader isDesktop={isDesktop} isActiveView={isActiveView}>
        <FilesWorkbenchToolbar
          isDesktop={isDesktop}
          isActiveView={isActiveView}
          canCreateFile={Boolean(untitledWorkspace)}
          canEdit={canEdit}
          onCommand={onMenuCommand}
          onCloseEditor={onCloseEditor}
        />
      </FilesWorkbenchHeader>
      <FilesWorkbenchWindowControls {...{ isDesktop, isMacDesktop, isActiveView }} />
      <FilesLargeTextDraftStatus drafts={controller.largeTextDrafts} />
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
        deleted={controller.conflictBuffer?.deleted}
        onDecide={(decision) => void controller.handleConflictDecision(decision)}
      />
      <FilesLargeTextConflictDialog
        open={Boolean(controller.largeConflictBuffer)}
        onDecide={(decision) => void controller.handleLargeConflictDecision(decision)}
      />
      <FilesExternalChangeReloadDialog
        open={Boolean(reloadConfirmBuffer)}
        name={reloadConfirmBuffer ? filesBufferTabTitle(reloadConfirmBuffer) : ""}
        onDecide={(decision) => void controller.handleExternalReloadDecision(decision)}
      />
      <FilesWorkbenchSaveAsDialog
        controller={controller}
        isDesktop={isDesktop}
        workspaceTabs={workspaceTabs}
        pendingSaveDirectory={pendingSaveDirectory}
        saveAsBuffer={filesActiveSavableBuffer(buffers, controller.saveAsBufferId)}
      />
    </section>
  );
}
