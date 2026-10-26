import { useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Rows2 } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveFilesWorkspaceDisambiguatedIds } from "@/files-workbench/filesEditorModel.js";
import { FilesEditorTabItem } from "@/files-workbench/FilesEditorTabItem.js";
import { FilesEditorTabSaveButton } from "@/files-workbench/FilesEditorTabSaveButton.js";
import { FILES_EDITOR_VIEW_DRAG_MIME } from "@/files-workbench/filesEditorDragTypes.js";
import type { FilesEditorSplitEdge } from "@/files-workbench/filesEditorLayout.js";
import { shouldCrowdFilesEditorTabs } from "@/files-workbench/filesEditorTabSizing.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import { useAnimatedFilesEditorTabs } from "@/files-workbench/filesEditorTabAnimation.js";
import type { FilesEditorTabEntry } from "@/files-workbench/filesEditorTabAnimation.js";

export function FilesEditorTabBar({
  groupId,
  isGroupFocused = true,
  tabs,
  activeViewId,
  onActivate,
  onKeepOpen,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseSaved,
  onCloseAll,
  onCopyPath,
  onRevealInFileTree,
  canCloseSaved,
  canRevealInFileTree,
  onSplit,
  onMoveView,
  onCreateUntitled,
  onSave,
  onSaveAs,
}: {
  groupId: string;
  isGroupFocused?: boolean;
  tabs: readonly FilesEditorTabEntry[];
  activeViewId?: string;
  onActivate: (viewId: string) => void;
  onKeepOpen: (bufferId: string) => void;
  onClose: (bufferId: string, viewId: string) => void;
  onCloseOthers: (bufferId: string, viewId: string, groupId: string) => void;
  onCloseToRight: (viewId: string, groupId: string) => void;
  onCloseSaved: () => void;
  onCloseAll: () => void;
  onCopyPath: (buffer: FilesBuffer, kind: "absolute" | "relative") => void;
  onRevealInFileTree: (buffer: FilesBuffer) => void;
  canRevealInFileTree: (buffer: FilesBuffer) => boolean;
  canCloseSaved: boolean;
  onSplit: (viewId: string, groupId: string, edge: FilesEditorSplitEdge) => void;
  onMoveView: (viewId: string, groupId: string, targetIndex?: number) => void;
  onCreateUntitled?: () => void;
  onSave: (bufferId: string) => void;
  onSaveAs: (bufferId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const [crowded, setCrowded] = useState(false);
  const [hoveredViewId, setHoveredViewId] = useState<string | undefined>();
  const { displayTabs, onEnterComplete, onExitComplete } = useAnimatedFilesEditorTabs(tabs);
  const buffers = useMemo(() => tabs.map((tab) => tab.buffer), [tabs]);
  const currentIndexById = useMemo(
    () => new Map(tabs.map((entry, index) => [entry.viewId, index])),
    [tabs],
  );
  // 一次渲染只算一遍消歧集合，避免逐 tab 比较退化为 O(N²)。
  const disambiguatedIds = useMemo(() => resolveFilesWorkspaceDisambiguatedIds(buffers), [buffers]);
  const activeTab = tabs.find((tab) => tab.viewId === activeViewId);
  const activeBuffer = activeTab?.buffer;

  useEffect(() => {
    const element = tabsContainerRef.current;
    if (!element) return;
    const updateCrowdedState = () => {
      const nextCrowded = shouldCrowdFilesEditorTabs(element.clientWidth, tabs.length);
      setCrowded((current) => (current === nextCrowded ? current : nextCrowded));
    };
    updateCrowdedState();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateCrowdedState);
      return () => window.removeEventListener("resize", updateCrowdedState);
    }
    const observer = new ResizeObserver(updateCrowdedState);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tabs.length]);

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "filesWorkbench.tabList" })}
      className="flex h-9 shrink-0 items-stretch overflow-x-hidden border-b border-border bg-background-alt select-none [app-region:no-drag]"
      // 只在真实控件相交处消费局部避让，不能为整窗再插入一条拖动行。
      style={{
        paddingLeft: "var(--files-tabbar-leading-inset, 0px)",
        paddingRight: "var(--files-tabbar-trailing-inset, 0px)",
        paddingTop: "var(--files-tabbar-top-inset, 0px)",
        height: "var(--files-tabbar-height, 36px)",
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes(FILES_EDITOR_VIEW_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        const draggedViewId = event.dataTransfer.getData(FILES_EDITOR_VIEW_DRAG_MIME);
        const target = event.target;
        if (!draggedViewId || !(target instanceof HTMLElement)) return;
        event.preventDefault();
        event.stopPropagation();
        if (target.closest("button")) return;
        const targetTab = target.closest<HTMLElement>('[role="tab"][data-editor-view-id]');
        if (targetTab) {
          const targetViewId = targetTab.dataset.editorViewId;
          const targetIndex = tabs.findIndex((tab) => tab.viewId === targetViewId);
          if (targetIndex >= 0) {
            const rect = targetTab.getBoundingClientRect();
            const insertAfter = event.clientX >= rect.left + rect.width / 2;
            onMoveView(draggedViewId, groupId, targetIndex + (insertAfter ? 1 : 0));
            return;
          }
        }
        onMoveView(draggedViewId, groupId, tabs.length);
      }}
    >
      <div
        ref={tabsContainerRef}
        className="flex min-w-0 flex-1 items-stretch overflow-hidden"
        onMouseLeave={() => setHoveredViewId(undefined)}
      >
        {displayTabs.map((entry) => (
          <FilesEditorTabItem
            key={entry.viewId}
            viewId={entry.viewId}
            buffer={entry.buffer}
            selected={!entry.exiting && entry.viewId === activeViewId}
            isGroupFocused={isGroupFocused}
            disambiguate={disambiguatedIds.has(entry.buffer.id)}
            canCloseOthers={tabs.length > 1}
            canCloseToRight={(currentIndexById.get(entry.viewId) ?? 0) < tabs.length - 1}
            canCloseSaved={canCloseSaved}
            canRevealInFileTree={canRevealInFileTree(entry.buffer)}
            crowded={crowded}
            hovered={hoveredViewId === entry.viewId}
            entering={entry.entering}
            exiting={entry.exiting}
            groupId={groupId}
            index={currentIndexById.get(entry.viewId) ?? 0}
            onActivate={onActivate}
            onKeepOpen={onKeepOpen}
            onSave={onSave}
            onSaveAs={onSaveAs}
            onClose={onClose}
            onCloseOthers={onCloseOthers}
            onCloseToRight={onCloseToRight}
            onCloseSaved={onCloseSaved}
            onCloseAll={onCloseAll}
            onCopyPath={onCopyPath}
            onRevealInFileTree={onRevealInFileTree}
            onSplit={onSplit}
            onMoveView={onMoveView}
            onHover={setHoveredViewId}
            onEnterComplete={onEnterComplete}
            onExitComplete={onExitComplete}
          />
        ))}
        {tabs.length === 0 ? (
          <div className="min-w-2 flex-1" onDoubleClick={() => onCreateUntitled?.()} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1">
        <FilesEditorTabSaveButton activeBuffer={activeBuffer} onSave={onSave} />
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "filesWorkbench.splitRight" })}
          title={intl.formatMessage({ id: "filesWorkbench.splitRight" })}
          disabled={!activeTab}
          className="flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          onClick={() => activeTab && onSplit(activeTab.viewId, groupId, "right")}
        >
          <Columns2 aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "filesWorkbench.splitDown" })}
          title={intl.formatMessage({ id: "filesWorkbench.splitDown" })}
          disabled={!activeTab}
          className="flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          onClick={() => activeTab && onSplit(activeTab.viewId, groupId, "bottom")}
        >
          <Rows2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
