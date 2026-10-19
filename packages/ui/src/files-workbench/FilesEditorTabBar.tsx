import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Rows2, X } from "lucide-react";
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
  resolveFilesWorkspaceDisambiguatedIds,
} from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorSplitEdge } from "@/files-workbench/filesEditorLayout.js";
import {
  filesEditorTabFlex,
  shouldCrowdFilesEditorTabs,
} from "@/files-workbench/filesEditorTabSizing.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import { FILES_EDITOR_VIEW_DRAG_MIME } from "@/files-workbench/filesEditorDragTypes.js";
import {
  useAnimatedFilesEditorTabs,
  useFilesEditorTabAnimation,
} from "@/files-workbench/filesEditorTabAnimation.js";
import type { FilesEditorTabEntry } from "@/files-workbench/filesEditorTabAnimation.js";

interface FilesEditorTabItemProps {
  viewId: string;
  buffer: FilesBuffer;
  selected: boolean;
  disambiguate: boolean;
  canCloseOthers: boolean;
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
  onMoveView: (viewId: string, groupId: string, targetIndex?: number) => void;
  onHover: (viewId?: string) => void;
  onEnterComplete: (viewId: string) => void;
  onExitComplete: (viewId: string) => void;
}

// 单个 tab 提成 memo：恢复数百个打开文件时，避免任一 tab 状态变化触发全列表
// 重新计算图标/标题/tooltip（2026-10-15 启动冻结 26s 的渲染风暴来源之一）。
const FilesEditorTabItem = memo(function FilesEditorTabItem({
  viewId,
  buffer,
  selected,
  disambiguate,
  canCloseOthers,
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
              ? "bg-background text-foreground"
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
      <ContextMenuContent className="w-44">
        <ContextMenuItem disabled={!previewTab} onSelect={() => onKeepOpen(buffer.id)}>
          {intl.formatMessage({ id: "filesWorkbench.keepOpen" })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onClose(buffer.id, viewId)}>
          {intl.formatMessage({ id: "filesWorkbench.closeTabMenu" })}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canCloseOthers}
          onSelect={() => onCloseOthers(buffer.id, viewId, groupId)}
        >
          {intl.formatMessage({ id: "filesWorkbench.closeOtherTabs" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export function FilesEditorTabBar({
  groupId,
  tabs,
  activeViewId,
  onActivate,
  onKeepOpen,
  onClose,
  onCloseOthers,
  onMoveView,
  onSplit,
  onCreateUntitled,
}: {
  groupId: string;
  tabs: readonly FilesEditorTabEntry[];
  activeViewId?: string;
  onActivate: (viewId: string) => void;
  onKeepOpen: (bufferId: string) => void;
  onClose: (bufferId: string, viewId: string) => void;
  onCloseOthers: (bufferId: string, viewId: string, groupId: string) => void;
  onMoveView: (viewId: string, groupId: string, targetIndex?: number) => void;
  onSplit: (viewId: string, groupId: string, edge: FilesEditorSplitEdge) => void;
  onCreateUntitled?: () => void;
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
            disambiguate={disambiguatedIds.has(entry.buffer.id)}
            canCloseOthers={tabs.length > 1}
            crowded={crowded}
            hovered={hoveredViewId === entry.viewId}
            entering={entry.entering}
            exiting={entry.exiting}
            groupId={groupId}
            index={currentIndexById.get(entry.viewId) ?? 0}
            onActivate={onActivate}
            onKeepOpen={onKeepOpen}
            onClose={onClose}
            onCloseOthers={onCloseOthers}
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
