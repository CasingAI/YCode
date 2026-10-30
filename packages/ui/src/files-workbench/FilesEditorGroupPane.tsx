import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import type {
  FilesEditorGroup,
  FilesEditorMarkdownViewMode,
  FilesEditorSplitEdge,
} from "@/files-workbench/filesEditorLayout.js";
import { FilesEditorStatusBar } from "@/files-workbench/FilesEditorStatusBar.js";
import { FilesEditorTabBar } from "@/files-workbench/FilesEditorTabBar.js";
import type {
  FilesEditorStatusHandle,
  FilesEditorStatusState,
  FilesEditorStatusLanguage,
} from "@/files-workbench/filesMonacoStatusHandle.js";
import type {
  FilesEditorGotoTarget,
  FilesEditorStatusMarker,
} from "@/files-workbench/filesEditorStatusModel.js";
import type { FilesEditorTabEntry } from "@/files-workbench/filesEditorTabAnimation.js";
import { isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import { FilesEditorExternalChangeBanner } from "@/files-workbench/FilesEditorExternalChangeBanner.js";
import { FilesEditorContent } from "@/files-workbench/FilesEditorContent.js";
import type {
  FilesBuffer,
  FilesEditorFocusRequest,
  FilesMonacoOpenPath,
  FilesMonacoRevealPosition,
} from "@/files-workbench/filesEditorTypes.js";
import {
  filesEditorDropEdgeAtEvent,
  filesEditorDropOverlayClass,
} from "@/files-workbench/filesEditorGroupDrop.js";
import {
  FILES_EDITOR_VIEW_DRAG_MIME,
  isFilesEditorViewDrag,
} from "@/files-workbench/filesEditorDragTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { filesEditorAssociationPatternForPath } from "@/files-workbench/filesEditorLanguageAssociations.js";
import { resolveFilesEditorMarkdownViewMode } from "@/files-workbench/filesEditorMarkdownMode.js";
import { cn } from "@/components/lib/utils.js";

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
  onSaveAs,
  onSetMarkdownViewMode,
  onFocusGroup,
  onEditorHandleChange,
  onExternalChangeAction,
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
  onSave: (bufferId: string) => void;
  onSaveAs: (bufferId: string) => void;
  /** Markdown 源码 / 预览模式只写到运行时 layout，不触发持久化。 */
  onSetMarkdownViewMode?: (viewId: string, mode: FilesEditorMarkdownViewMode) => void;
  onFocusGroup: (groupId: string) => void;
  /** 上报本组的编辑器句柄：菜单的撤销/重做/查找按聚焦组定位编辑器。 */
  onEditorHandleChange?: (
    groupId: string,
    handle: FilesEditorStatusHandle | null,
    bufferId?: string,
  ) => void;
  /** 外部变化提示条动作：重载先经 controller 确认，保留只清除提示。 */
  onExternalChangeAction: (bufferId: string, action: "reload" | "dismiss") => void;
}) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const [dropEdge, setDropEdge] = useState<FilesEditorSplitEdge | undefined>();
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
  const activeView = group.views.find((view) => view.id === activeEntry?.viewId);
  // 模式按 view 保存；语言或加载状态变化时可用性重新派生，残留模式自动忽略。
  const markdownViewMode = resolveFilesEditorMarkdownViewMode(
    activeView ?? { markdownViewMode: undefined },
    activeBuffer,
    settings?.fileLanguageAssociations,
  );
  const markdownPreviewActive = markdownViewMode === "preview";
  // 只有真正进入过文件视图才挂载编辑器；外壳与提示条不依赖重量级编辑器挂载。
  const editorBuffer = hasEnteredFiles ? activeBuffer : undefined;
  // 状态栏句柄由 Monaco 编辑器交出；这里只订阅快照并转发命令。
  const [statusBinding, setStatusBinding] = useState<{
    bufferId: string;
    handle: FilesEditorStatusHandle;
  } | null>(null);
  // 文本标签切到预览/另一文本时，不能让菜单和状态栏继续使用上一张标签的句柄。
  // 大文本块编辑器也交出同形句柄供菜单撤销 / 重做 / 查找使用，
  // 但它不提供全文件行号 / 语言等状态栏信息，因此不显示普通 status bar。
  const statusHandle = statusBinding?.bufferId === activeBuffer?.id ? statusBinding?.handle : null;
  const [statusState, setStatusState] = useState<FilesEditorStatusState | null>(null);
  const [statusLanguages, setStatusLanguages] = useState<FilesEditorStatusLanguage[]>([]);
  const onStatusHandleChange = useCallback(
    (handle: FilesEditorStatusHandle | null) => {
      setStatusBinding(handle && activeBuffer ? { bufferId: activeBuffer.id, handle } : null);
    },
    [activeBuffer?.id],
  );
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
  // 大文件同样上报，Store 的 saveToken guards 会拒绝保存中的撤销 / 重做。
  // 预览态不上报：隐藏的源码编辑器已 inert，撤销 / 重做 / 查找不得暗中改源码。
  useEffect(() => {
    onEditorHandleChange?.(
      group.id,
      markdownPreviewActive ? null : (statusHandle ?? null),
      activeBuffer?.id,
    );
  }, [activeBuffer?.id, group.id, markdownPreviewActive, onEditorHandleChange, statusHandle]);
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
    const edge = filesEditorDropEdgeAtEvent(event);
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
    const edge = filesEditorDropEdgeAtEvent(event);
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
      data-editor-group-focused={isFocused}
      // 组聚焦整圈描边会在外壳圆角内叠出方框；边界由外壳负责，聚焦只投影到活动标签。
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden [app-region:no-drag]"
      onPointerDownCapture={() => onFocusGroup(group.id)}
      // 键盘 Tab / 查找命令也能切换编辑器组，不能只用鼠标按下决定菜单操作对象。
      onFocusCapture={() => onFocusGroup(group.id)}
      onDragOverCapture={handleDragOverCapture}
      onDragLeave={handleDragLeave}
      onDropCapture={handleDropCapture}
    >
      <FilesEditorTabBar
        groupId={group.id}
        isGroupFocused={isFocused}
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
        onSaveAs={onSaveAs}
        markdownViewMode={markdownViewMode}
        onSetMarkdownViewMode={
          onSetMarkdownViewMode && activeView
            ? (mode) => onSetMarkdownViewMode(activeView.id, mode)
            : undefined
        }
      />
      <FilesEditorExternalChangeBanner
        buffer={editorBuffer}
        onReload={() => editorBuffer && onExternalChangeAction(editorBuffer.id, "reload")}
        onKeep={() => editorBuffer && onExternalChangeAction(editorBuffer.id, "dismiss")}
      />
      <FilesEditorContent
        buffer={editorBuffer}
        viewId={activeEntry?.viewId}
        isActiveView={isActiveView}
        markdownPreviewActive={markdownPreviewActive}
        loadRestoredTextFile={loadRestoredTextFile}
        onChange={onChange}
        onOpenPath={onOpenPath}
        revealPosition={revealPosition}
        onRevealPositionApplied={onRevealPositionApplied}
        focusRequest={focusRequest}
        onFocusApplied={onFocusApplied}
        onStatusHandleChange={onStatusHandleChange}
        onClose={onClose}
        onExternalChangeAction={onExternalChangeAction}
      />
      {activeBuffer?.kind !== "large-text" && statusHandle && statusState ? (
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
            filesEditorDropOverlayClass(dropEdge),
          )}
        />
      ) : null}
    </section>
  );
}
