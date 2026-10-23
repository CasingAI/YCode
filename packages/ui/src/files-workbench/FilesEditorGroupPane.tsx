import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import { Loader2 } from "lucide-react";
import type {
  FilesEditorGroup,
  FilesEditorSplitEdge,
} from "@/files-workbench/filesEditorLayout.js";
import { FilesEditorStatusBar } from "@/files-workbench/FilesEditorStatusBar.js";
import { FilesEditorTabBar } from "@/files-workbench/FilesEditorTabBar.js";
import type {
  FilesEditorStatusHandle,
  FilesEditorStatusState,
} from "@/files-workbench/filesMonacoStatusHandle.js";
import type { FilesEditorStatusLanguage } from "@/files-workbench/filesMonacoStatusHandle.js";
import type {
  FilesEditorGotoTarget,
  FilesEditorStatusMarker,
} from "@/files-workbench/filesEditorStatusModel.js";
import type { FilesEditorTabEntry } from "@/files-workbench/filesEditorTabAnimation.js";
import { isFilesPreviewBuffer, isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import type {
  FilesBuffer,
  FilesEditorFocusRequest,
  FilesMonacoOpenPath,
  FilesMonacoRevealPosition,
} from "@/files-workbench/filesEditorTypes.js";
import { filesEditorSplitEdgeAtPoint } from "@/files-workbench/filesEditorDropZone.js";
import {
  FILES_EDITOR_VIEW_DRAG_MIME,
  isFilesEditorViewDrag,
} from "@/files-workbench/filesEditorDragTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { filesEditorAssociationPatternForPath } from "@/files-workbench/filesEditorLanguageAssociations.js";
import { PreviewPane } from "@/PreviewPane.js";
import { cn } from "@/components/lib/utils.js";

const FilesMonacoEditor = lazy(async () => {
  const module = await import("@/files-workbench/FilesMonacoEditor.js");
  return { default: module.FilesMonacoEditor };
});

function getDropEdge(event: DragEvent<HTMLDivElement>): FilesEditorSplitEdge | undefined {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('[role="tablist"]')) return undefined;
  const rect = event.currentTarget.getBoundingClientRect();
  return filesEditorSplitEdgeAtPoint(event.clientX, event.clientY, rect);
}

function dropOverlayClass(edge: FilesEditorSplitEdge): string {
  switch (edge) {
    case "left":
      return "inset-y-0 left-0 w-1/2 border-r-2";
    case "right":
      return "inset-y-0 right-0 w-1/2 border-l-2";
    case "top":
      return "inset-x-0 top-0 h-1/2 border-b-2";
    case "bottom":
      return "inset-x-0 bottom-0 h-1/2 border-t-2";
  }
}

export function FilesEditorGroupPane({
  group,
  buffers,
  isActiveView,
  hasEnteredFiles,
  isFocused,
  loadRestoredTextFile,
  onActivate,
  onKeepOpen,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseSaved,
  onCloseAll,
  canCloseSaved,
  onCopyPath,
  onRevealInFileTree,
  canRevealInFileTree,
  onMoveView,
  onSplit,
  onChange,
  onOpenPath,
  revealPosition,
  onRevealPositionApplied,
  focusRequest,
  onFocusApplied,
  onCreateUntitled,
  onSave,
  onFocusGroup,
  onEditorHandleChange,
}: {
  group: FilesEditorGroup;
  buffers: readonly FilesBuffer[];
  isActiveView: boolean;
  hasEnteredFiles: boolean;
  isFocused: boolean;
  loadRestoredTextFile: (id: string) => Promise<void>;
  onActivate: (viewId: string) => void;
  onKeepOpen: (bufferId: string) => void;
  onClose: (bufferId: string, viewId: string) => void;
  onCloseOthers: (keepBufferId: string, keepViewId: string, groupId: string) => void;
  onCloseToRight: (viewId: string, groupId: string) => void;
  onCloseSaved: () => void;
  onCloseAll: () => void;
  canCloseSaved: boolean;
  onCopyPath: (buffer: FilesBuffer, kind: "absolute" | "relative") => void;
  onRevealInFileTree: (buffer: FilesBuffer) => void;
  canRevealInFileTree: (buffer: FilesBuffer) => boolean;
  onMoveView: (viewId: string, groupId: string, targetIndex?: number) => void;
  onSplit: (
    viewId: string,
    groupId: string,
    edge: FilesEditorSplitEdge,
    mode?: "move" | "copy",
  ) => void;
  onChange: (bufferId: string, text: string) => void;
  onOpenPath: FilesMonacoOpenPath;
  revealPosition?: FilesMonacoRevealPosition;
  onRevealPositionApplied: (path: string) => void;
  /** 打开文件后的聚焦意图：目标文件就是本组活动缓冲时生效。 */
  focusRequest?: FilesEditorFocusRequest;
  onFocusApplied?: (requestId: number) => void;
  onCreateUntitled: () => void;
  onSave?: (bufferId: string) => void;
  onFocusGroup: (groupId: string) => void;
  /** 上报本组的编辑器句柄：菜单的撤销/重做/查找按聚焦组定位编辑器。 */
  onEditorHandleChange?: (groupId: string, handle: FilesEditorStatusHandle | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const [dropEdge, setDropEdge] = useState<FilesEditorSplitEdge | undefined>();
  // 状态栏句柄由 Monaco 编辑器交出；这里只订阅快照并转发命令。
  const [statusHandle, setStatusHandle] = useState<FilesEditorStatusHandle | null>(null);
  const [statusState, setStatusState] = useState<FilesEditorStatusState | null>(null);
  const [statusLanguages, setStatusLanguages] = useState<FilesEditorStatusLanguage[]>([]);
  const onStatusHandleChange = useCallback((handle: FilesEditorStatusHandle | null) => {
    setStatusHandle(handle);
  }, []);
  useEffect(() => {
    if (!statusHandle) {
      setStatusState(null);
      return;
    }
    setStatusState(statusHandle.getState());
    setStatusLanguages(statusHandle.getLanguages());
    return statusHandle.subscribe(setStatusState);
  }, [statusHandle]);
  // 句柄上报给文件工作台：菜单命令据此找到「聚焦组」的编辑器。
  useEffect(() => {
    onEditorHandleChange?.(group.id, statusHandle);
  }, [group.id, onEditorHandleChange, statusHandle]);
  // 卸载时清掉本组句柄，避免菜单命令命中已销毁的编辑器。
  useEffect(
    () => () => {
      onEditorHandleChange?.(group.id, null);
    },
    [group.id, onEditorHandleChange],
  );
  const onStatusGoToLine = useCallback(
    (target: FilesEditorGotoTarget) => statusHandle?.goToLine(target),
    [statusHandle],
  );
  const onStatusSetIndentation = useCallback(
    (next: { insertSpaces: boolean; tabSize: number }) => statusHandle?.setIndentation(next),
    [statusHandle],
  );
  const onStatusSetLanguage = useCallback(
    (languageId: string) => statusHandle?.setLanguage(languageId),
    [statusHandle],
  );
  const onStatusSetEol = useCallback(
    (eol: "LF" | "CRLF") => statusHandle?.setEol(eol),
    [statusHandle],
  );
  const onStatusRevealMarker = useCallback(
    (marker: FilesEditorStatusMarker) => statusHandle?.revealMarker(marker),
    [statusHandle],
  );
  const bufferById = useMemo(
    () => new Map(buffers.map((buffer) => [buffer.id, buffer])),
    [buffers],
  );
  const tabs = useMemo<FilesEditorTabEntry[]>(
    () =>
      group.views.flatMap((view) => {
        const buffer = bufferById.get(view.bufferId);
        return buffer ? [{ viewId: view.id, buffer }] : [];
      }),
    [bufferById, group.views],
  );
  const activeEntry = tabs.find((entry) => entry.viewId === group.activeViewId) ?? tabs[0];
  const activeBuffer = activeEntry?.buffer;

  // 「保存为文件关联」：把当前语言写成用户关联规则。
  // 按模式写 `*.ext`（影响所有同后缀文件），按文件写绝对路径（只影响这一个文件）。
  const onStatusSaveLanguageAssociation = useCallback(
    (languageId: string, scope: "pattern" | "file") => {
      const path = activeBuffer?.path;
      if (!path) {
        return;
      }
      const key = scope === "file" ? path : filesEditorAssociationPatternForPath(path);
      void update({
        fileLanguageAssociations: {
          ...settings?.fileLanguageAssociations,
          [key]: languageId,
        },
      })
        .then(() => {
          toast(
            intl.formatMessage(
              { id: "filesWorkbench.statusBar.languageAssociationSaved" },
              { key },
            ),
          );
        })
        .catch((error: unknown) => {
          logger.error("[files-workbench] 保存文件语言关联失败", {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
          toast(intl.formatMessage({ id: "filesWorkbench.statusBar.languageAssociationFailed" }));
        });
    },
    [activeBuffer?.path, intl, settings?.fileLanguageAssociations, update],
  );

  useEffect(() => {
    if (
      !isActiveView ||
      !hasEnteredFiles ||
      !activeBuffer ||
      !isFilesTextBuffer(activeBuffer) ||
      activeBuffer.loadState !== "unloaded"
    ) {
      return;
    }
    void loadRestoredTextFile(activeBuffer.id);
  }, [activeBuffer, hasEnteredFiles, isActiveView, loadRestoredTextFile]);

  const isOverTabBar = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest('[role="tablist"]'));

  // Capture internal tab drags before Monaco's own drag/drop handlers can treat
  // the tab payload as text and insert the tab title into the current document.
  // Tab-bar drops are left alone so the tab list can reorder views normally.
  const handleDragOverCapture = (event: DragEvent<HTMLDivElement>) => {
    if (!isFilesEditorViewDrag(event.dataTransfer) || isOverTabBar(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const edge = getDropEdge(event);
    setDropEdge((current) => (current === edge ? current : edge));
  };

  const handleDropCapture = (event: DragEvent<HTMLDivElement>) => {
    if (!isFilesEditorViewDrag(event.dataTransfer) || isOverTabBar(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const draggedViewId = event.dataTransfer.getData(FILES_EDITOR_VIEW_DRAG_MIME);
    if (!draggedViewId) {
      setDropEdge(undefined);
      return;
    }
    const edge = getDropEdge(event);
    if (edge) {
      // Dragging a tab onto an edge moves that view into the new split. The
      // tab-bar split button deliberately uses copy mode, but a drag must not
      // leave the original view behind and appear to split a tab with itself.
      onSplit(draggedViewId, group.id, edge, "move");
    } else if (!group.views.some((view) => view.id === draggedViewId)) {
      // Dropping into the body of the same editor group is a no-op; only a
      // different group should receive a center-drop move.
      onMoveView(draggedViewId, group.id, group.views.length);
    }
    setDropEdge(undefined);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropEdge(undefined);
  };

  return (
    <section
      role="group"
      data-editor-group-id={group.id}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-transparent [app-region:no-drag]",
        isFocused && "border-brand/40",
      )}
      onPointerDownCapture={() => onFocusGroup(group.id)}
      onDragOverCapture={handleDragOverCapture}
      onDragLeave={handleDragLeave}
      onDropCapture={handleDropCapture}
    >
      <FilesEditorTabBar
        groupId={group.id}
        tabs={tabs}
        activeViewId={activeEntry?.viewId}
        onActivate={onActivate}
        onKeepOpen={onKeepOpen}
        onClose={onClose}
        onCloseOthers={(bufferId, viewId, _groupId) => onCloseOthers(bufferId, viewId, group.id)}
        onCloseToRight={(viewId, _groupId) => onCloseToRight(viewId, group.id)}
        onCloseSaved={onCloseSaved}
        onCloseAll={onCloseAll}
        canCloseSaved={canCloseSaved}
        onCopyPath={onCopyPath}
        onRevealInFileTree={onRevealInFileTree}
        canRevealInFileTree={canRevealInFileTree}
        onMoveView={onMoveView}
        onSplit={(viewId, groupId, edge) => onSplit(viewId, groupId, edge, "copy")}
        onCreateUntitled={onCreateUntitled}
        onSave={onSave}
      />
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden [app-region:no-drag]">
        {hasEnteredFiles &&
        activeBuffer &&
        isFilesTextBuffer(activeBuffer) &&
        (activeBuffer.loadState === "unloaded" || activeBuffer.loadState === "loading") ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-ui-sm text-foreground-subtle"
            role="status"
            aria-live="polite"
          >
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span>{intl.formatMessage({ id: "filesWorkbench.loadingFile" })}</span>
          </div>
        ) : hasEnteredFiles &&
          activeBuffer &&
          isFilesTextBuffer(activeBuffer) &&
          activeBuffer.loadState === "error" ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 text-center text-ui-sm text-foreground-subtle"
            role="alert"
          >
            <span>{intl.formatMessage({ id: "filesWorkbench.loadFileError" })}</span>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-ui-sm hover:bg-surface-hover"
              onClick={() => void loadRestoredTextFile(activeBuffer.id)}
            >
              {intl.formatMessage({ id: "filesWorkbench.retryLoadFile" })}
            </button>
          </div>
        ) : hasEnteredFiles && activeBuffer && isFilesTextBuffer(activeBuffer) ? (
          <Suspense fallback={null}>
            <FilesMonacoEditor
              buffer={activeBuffer}
              onChange={(text) => onChange(activeBuffer.id, text)}
              onOpenPath={onOpenPath}
              revealPosition={revealPosition}
              onRevealPositionApplied={onRevealPositionApplied}
              focusRequest={focusRequest}
              onFocusApplied={onFocusApplied}
              onStatusHandleChange={onStatusHandleChange}
            />
          </Suspense>
        ) : hasEnteredFiles && activeBuffer && isFilesPreviewBuffer(activeBuffer) ? (
          <PreviewPane
            source={{
              type: "file",
              title: activeBuffer.title,
              path: activeBuffer.path,
              workspacePath: activeBuffer.workspace.workspacePath,
              workspaceIdentity: activeBuffer.workspace.workspaceIdentity,
              workspaceRemoteSessionId: activeBuffer.workspace.workspaceRemoteSessionId,
            }}
            workspacePath={activeBuffer.workspace.workspacePath}
            onClose={() => onClose(activeBuffer.id, activeEntry.viewId)}
            variant="workbench"
          />
        ) : (
          <p className="px-6 py-12 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "filesWorkbench.emptyEditor" })}
          </p>
        )}
      </div>
      {statusState ? (
        <FilesEditorStatusBar
          state={statusState}
          languages={statusLanguages}
          filePath={activeBuffer?.path}
          onGoToLine={onStatusGoToLine}
          onSetIndentation={onStatusSetIndentation}
          onSetLanguage={onStatusSetLanguage}
          onSaveLanguageAssociation={onStatusSaveLanguageAssociation}
          onSetEol={onStatusSetEol}
          onRevealMarker={onStatusRevealMarker}
        />
      ) : null}
      {dropEdge ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute z-20 border-brand bg-brand/10",
            dropOverlayClass(dropEdge),
          )}
        />
      ) : null}
    </section>
  );
}
