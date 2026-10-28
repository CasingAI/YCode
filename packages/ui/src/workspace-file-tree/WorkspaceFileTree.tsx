/* eslint-disable max-lines -- WorkspaceFileTree 需要集中编排数据、虚拟列表、吸顶和入口操作状态。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { ArrowLeft, Copy, Ellipsis, FolderOpen, RefreshCw } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { writeTextToClipboard } from "@/lib/clipboard.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
} from "@zcode/shared";
import {
  areWorkspaceFilePathsEqual,
  createCodeViewerSourceForWorkspaceFile,
  getWorkspaceFileGitStatus,
  getWorkspaceFileAncestorDirectories,
  getWorkspaceFileDirectoryChildDepth,
  filterWorkspaceFileTreeRows,
  isWorkspaceFileTreeDeletedFile,
  isWorkspaceFilePathInside,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import { getPathLeaf } from "@/lib/path.js";
import { planWorkspaceFileTreeMutation } from "@/workspace-file-tree/fileActionTreeRefresh.js";
import { useWorkspaceFileActions } from "@/hooks/useWorkspaceFileActions.js";
import {
  WorkspaceFileActionContext,
  WorkspaceFileRootMenu,
} from "@/workspace-file-tree/WorkspaceFileActionMenu.js";
import { WorkspaceFileActionDialog } from "@/workspace-file-tree/WorkspaceFileActionDialog.js";
import { logger } from "@/logger.js";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import { getFileManagerLabel } from "@/workspace-file-tree/helpers.js";
import { useInstalledFileTreeEditors } from "@/workspace-file-tree/useInstalledFileTreeEditors.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import {
  resolveWorkspaceEditorSelection,
  resolveWorkspaceFileManagerEditor,
} from "@/lib/workspaceEditorSelection.js";
import { useWorkspaceFileTreeData } from "@/workspace-file-tree/useWorkspaceFileTreeData.js";
import { useWorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/useWorkspaceFileTreeStickyFolders.js";
import {
  useWorkspaceFileSearchIndex,
  useWorkspaceFileSearchResults,
} from "@/workspace-file-tree/useWorkspaceFileSearchIndex.js";
import {
  WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
  WorkspaceFileTreeList,
} from "@/workspace-file-tree/WorkspaceFileTreeList.js";
import { WorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/WorkspaceFileTreeStickyFolders.js";
import { WorkspaceFileTreeHeader } from "@/workspace-file-tree/WorkspaceFileTreeHeader.js";
import { WorkspaceFileTreeSearchHeader } from "@/workspace-file-tree/WorkspaceFileTreeSearchHeader.js";
import {
  createWorkspaceFileTreeRowsFromSearchEntries,
  getWorkspaceFileSearchDirectoryRevealPaths,
} from "@/workspace-file-tree/searchRows.js";
import {
  clearWorkspaceFileTreeSearchFilters,
  clearWorkspaceFileTreeSearchForDirectoryReveal,
  createWorkspaceFileTreeSearchState,
  isWorkspaceFileTreeSearchActive,
  WORKSPACE_FILE_SEARCH_RESULT_LIMIT,
  type WorkspaceFileTreeSearchState,
} from "@/workspace-file-tree/workspaceFileTreeSearchModel.js";
import type {
  WorkspaceFileTreeProps,
  WorkspaceFileTreeStickyFolderItem,
} from "@/workspace-file-tree/types.js";

function getWorkspaceFileTreeDirectoryLoadDepth(
  workspacePath: string,
  directoryPath: string,
): number {
  return getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath);
}

export function WorkspaceFileTree({
  workspacePath,
  workspaceName,
  workspaceIdentity,
  workspaceRemoteSessionId,
  revealPath,
  temporaryExternalDirectory = false,
  canOpenLocalFileManager = false,
  activePreviewPath,
  onClose,
  onOpenBrowserUrl,
  onOpenPreview,
  onSelectedPathChange,
  renderHeader,
}: WorkspaceFileTreeProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingActivePreviewRevealPathRef = useRef<string | null>(null);
  const pendingSearchDirectoryRevealPathRef = useRef<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [searchState, setSearchState] = useState<WorkspaceFileTreeSearchState>(
    createWorkspaceFileTreeSearchState,
  );
  const [showScrollBottomMask, setShowScrollBottomMask] = useState(false);
  const [hasScrollableFileTree, setHasScrollableFileTree] = useState(false);
  const updateSearchState = useCallback((patch: Partial<WorkspaceFileTreeSearchState>) => {
    setSearchState((current) => ({ ...current, ...patch }));
  }, []);
  const clearSearchFilters = useCallback(() => {
    setSearchState(clearWorkspaceFileTreeSearchFilters);
  }, []);
  const handleListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) {
      node.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollRef.current?.scrollTop ?? 0}px`,
      );
    }
  }, []);
  const treeData = useWorkspaceFileTreeData({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    enableWorkspaceFeatures: !temporaryExternalDirectory,
  });
  const { installedEditors } = useInstalledFileTreeEditors();
  const isRemoteWorkspaceFileTree = Boolean(workspaceRemoteSessionId || workspaceIdentity);
  const { remoteTarget } = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const availableEditors = useMemo(
    () =>
      isRemoteWorkspaceFileTree && !remoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors,
            selectedEditorId: null,
            remoteTarget,
          }).availableEditors,
    [installedEditors, isRemoteWorkspaceFileTree, remoteTarget],
  );
  const wslFileManagerEditor = resolveWorkspaceFileManagerEditor(availableEditors, remoteTarget);
  const canOpenInFileManager =
    Boolean(wslFileManagerEditor) || (canOpenLocalFileManager && !isRemoteWorkspaceFileTree);
  const showSearchResults = isWorkspaceFileTreeSearchActive(searchState);
  const searchIndex = useWorkspaceFileSearchIndex({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    includeIgnored: searchState.includeIgnored,
    enabled: showSearchResults,
  });
  const {
    entries: searchIndexEntries,
    error: searchIndexError,
    loaded: searchIndexLoaded,
    loading: searchIndexLoading,
    refresh: refreshSearchIndex,
  } = searchIndex;
  const allowedSearchPaths = useMemo(
    () => (searchState.changedOnly ? Array.from(treeData.gitStatusByPath.keys()) : undefined),
    [searchState.changedOnly, treeData.gitStatusByPath],
  );
  const searchResults = useWorkspaceFileSearchResults({
    entries: searchIndexEntries,
    query: searchState.query,
    include: searchState.include,
    exclude: searchState.exclude,
    allowedPaths: allowedSearchPaths,
    workspacePath,
  });
  const searchRows = useMemo(
    () => createWorkspaceFileTreeRowsFromSearchEntries(searchResults.entries),
    [searchResults.entries],
  );
  const visibleRows = useMemo(() => {
    if (showSearchResults) {
      return searchRows;
    }
    return filterWorkspaceFileTreeRows({
      rows: treeData.rows,
      searchQuery: searchState.query,
      changedOnly: searchState.changedOnly,
      statusByPath: treeData.gitStatusByPath,
    });
  }, [
    searchRows,
    searchState.changedOnly,
    searchState.query,
    showSearchResults,
    treeData.gitStatusByPath,
    treeData.rows,
  ]);
  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    const row = visibleRows.find((candidate) => candidate.path === selectedPath);
    onSelectedPathChange?.(selectedPath, row?.type === "directory");
  }, [onSelectedPathChange, selectedPath, visibleRows]);
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    overscan: 12,
  });

  useEffect(() => {
    setSelectedPath(null);
    setSearchState(createWorkspaceFileTreeSearchState());
  }, [workspaceIdentity, workspacePath, workspaceRemoteSessionId]);

  useEffect(() => {
    if (!treeData.gitStatusAvailable) {
      setSearchState((current) =>
        current.changedOnly ? { ...current, changedOnly: false } : current,
      );
    }
  }, [treeData.gitStatusAvailable]);

  const rootLoading = treeData.loadingDirectoryPaths.has(workspacePath);
  const rootLoaded = treeData.loadedDirectoryPaths.has(workspacePath);
  const rootError = treeData.errorByDirectory.get(workspacePath) ?? null;
  const blockingRootError = getWorkspaceFileTreeBlockingRootError({
    rootLoaded,
    rootError,
  });
  const showInitialLoading = !rootLoaded && !blockingRootError;
  const lastNonBlockingRootErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rootLoaded || !rootError) {
      lastNonBlockingRootErrorRef.current = null;
      return;
    }
    const errorMessage = rootError.message;
    if (lastNonBlockingRootErrorRef.current === errorMessage) {
      return;
    }
    lastNonBlockingRootErrorRef.current = errorMessage;
    // 根目录已有缓存时，刷新失败只能作为非阻塞提示；阻塞错误页会把保留的旧文件树隐藏掉。
    toast(`${intl.formatMessage({ id: "workspaceFileTree.readFailed" })}: ${errorMessage}`);
  }, [intl, rootError, rootLoaded]);
  const gitStatusLabelByStatus = useMemo<Record<WorkspaceFileGitStatus, string>>(
    () => ({
      added: intl.formatMessage({ id: "git.kind.added" }),
      deleted: intl.formatMessage({ id: "git.kind.deleted" }),
      ignored: intl.formatMessage({
        id: "workspaceFileTree.gitStatus.ignored",
      }),
      modified: intl.formatMessage({ id: "git.kind.modified" }),
      renamed: intl.formatMessage({ id: "git.kind.renamed" }),
      untracked: intl.formatMessage({ id: "git.section.untracked" }),
    }),
    [intl],
  );
  const fileManagerLabel = getFileManagerLabel(intl);
  const fileContextMenuLabels = useMemo(
    () => ({
      copyAbsolutePath: intl.formatMessage({
        id: "fileActions.copyAbsolutePath",
      }),
      copyRelativePath: intl.formatMessage({
        id: "fileActions.copyRelativePath",
      }),
      open: intl.formatMessage({ id: "common.open" }),
      openInBrowser: intl.formatMessage({
        id: "workspaceFileTree.openInBrowser",
      }),
      openFailed: intl.formatMessage({ id: "workspaceFileTree.openFailed" }),
      openWith: intl.formatMessage({ id: "workspaceFileTree.openWith" }),
      reveal: fileManagerLabel,
    }),
    [fileManagerLabel, intl],
  );

  const scrollMaskStyle = useMemo<CSSProperties | undefined>(() => {
    if (!showScrollBottomMask) {
      return undefined;
    }
    return {
      WebkitMaskImage:
        "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      maskImage: "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskSize: "100% 100%",
      maskSize: "100% 100%",
    };
  }, [showScrollBottomMask]);
  const scrollContainerStyle = useMemo<CSSProperties>(
    () => ({ ...scrollMaskStyle, overflowAnchor: "none" }),
    [scrollMaskStyle],
  );

  useEffect(() => {
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || !isWorkspaceFilePathInside(workspacePath, previewPath)) {
      return;
    }
    let disposed = false;
    const ancestorDirectories = getWorkspaceFileAncestorDirectories(workspacePath, previewPath);
    const directoryPathsToExpand = revealPath?.trim()
      ? [...ancestorDirectories, previewPath]
      : ancestorDirectories;
    pendingActivePreviewRevealPathRef.current = previewPath;
    setSelectedPath(previewPath);
    treeData.setExpandedPaths((current) => {
      const next = new Set(current);
      for (const directoryPath of directoryPathsToExpand) {
        next.add(directoryPath);
      }
      return next;
    });
    void (async () => {
      for (const [index, directoryPath] of directoryPathsToExpand.entries()) {
        if (disposed) {
          return;
        }
        await treeData.loadDirectory(directoryPath, index + 1);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    activePreviewPath,
    revealPath,
    treeData.loadDirectory,
    treeData.setExpandedPaths,
    workspacePath,
  ]);

  useEffect(() => {
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || visibleRows.length === 0) {
      return;
    }
    if (
      !isWorkspaceFilePathInside(workspacePath, previewPath) ||
      !pendingActivePreviewRevealPathRef.current ||
      !areWorkspaceFilePathsEqual(pendingActivePreviewRevealPathRef.current, previewPath)
    ) {
      return;
    }
    const activeRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, previewPath),
    );
    if (activeRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(activeRowIndex, { align: "auto" });
      pendingActivePreviewRevealPathRef.current = null;
    }
  }, [activePreviewPath, revealPath, rowVirtualizer, visibleRows, workspacePath]);

  useEffect(() => {
    const revealDirectoryPath = pendingSearchDirectoryRevealPathRef.current;
    if (!revealDirectoryPath || visibleRows.length === 0 || showSearchResults) {
      return;
    }
    const revealRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, revealDirectoryPath),
    );
    if (revealRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(revealRowIndex, { align: "center" });
      pendingSearchDirectoryRevealPathRef.current = null;
    }
  }, [rowVirtualizer, showSearchResults, visibleRows]);

  useEffect(() => {
    const scrollNode = scrollRef.current;
    if (!scrollNode) {
      return;
    }
    const contentNode = scrollNode.firstElementChild;
    const updateScrollMask = () => {
      // virtualizer 的 scrollOffset 需要经过 React 重渲染，拖拽滚动条时
      // mask 会落后一帧。原生 scroll 回调直接更新 CSS 变量，与浏览器滚动同步绘制。
      listRef.current?.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollNode.scrollTop}px`,
      );
      const hasOverflow = scrollNode.scrollHeight > scrollNode.clientHeight + 1;
      const isAtBottom =
        scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 1;
      setHasScrollableFileTree(hasOverflow);
      setShowScrollBottomMask(hasOverflow && !isAtBottom);
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateScrollMask();
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateScrollMask;
      debouncedUpdate();
    });
    resizeObserver.observe(scrollNode);
    if (contentNode instanceof HTMLElement) {
      resizeObserver.observe(contentNode);
    }
    scrollNode.addEventListener("scroll", updateScrollMask, { passive: true });
    window.addEventListener("resize", debouncedUpdate);
    return () => {
      resizeObserver.disconnect();
      scrollNode.removeEventListener("scroll", updateScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [rootError, rootLoaded, rootLoading, visibleRows.length]);

  const handleRefresh = useCallback(() => {
    void treeData.refreshLoadedDirectories();
    refreshSearchIndex();
  }, [refreshSearchIndex, treeData]);
  const refreshInProgress =
    rootLoading || treeData.refreshingLoadedDirectories || searchIndexLoading;

  const handleOpenInFileManager = useCallback(async () => {
    if (!canOpenInFileManager) {
      return;
    }
    const result = wslFileManagerEditor
      ? await platform.openInEditor(wslFileManagerEditor.id, workspacePath, {
          pathKind: "directory",
          remoteTarget,
          workspaceIdentity,
        })
      : await platform.openInFileManager(workspacePath);
    if (!result.success) {
      logger.warn("[WorkspaceFileTree] 打开 workspace 路径失败", {
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [
    canOpenInFileManager,
    intl,
    platform,
    remoteTarget,
    workspaceIdentity,
    workspacePath,
    wslFileManagerEditor,
  ]);

  const handleCopyPath = useCallback(async () => {
    try {
      await writeTextToClipboard(workspacePath);
      logger.info("[WorkspaceFileTree] workspace 路径已复制", {
        path: workspacePath,
      });
    } catch (error) {
      logger.warn("[WorkspaceFileTree] 复制 workspace 路径失败", {
        path: workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(
        intl.formatMessage(
          { id: "clipboard.copyFailed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
        { variant: "warning" },
      );
    }
  }, [intl, workspacePath]);

  const handleToggleDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(row.path)) {
          for (const path of row.compactedPaths ?? [row.path]) {
            next.delete(path);
          }
          return next;
        }
        next.add(row.path);
        return next;
      });
      if (!row.expanded) {
        // compact folders 的 row.depth 是压缩后的视觉深度，不能用于写入新加载节点。
        // 使用物理路径深度后，flatten 阶段再扣除 compact offset，子内容才不会与父目录同级。
        void treeData.loadDirectory(
          row.path,
          getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, row.path),
        );
      }
    },
    [treeData, workspacePath],
  );
  const handleRetryDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory" || !row.error) return;
      treeData.setExpandedPaths((current) => new Set(current).add(row.path));
      void treeData.loadDirectory(
        row.path,
        getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, row.path),
        { force: true },
      );
    },
    [treeData, workspacePath],
  );
  const handleRevealSearchDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      const directoryPathsToExpand = getWorkspaceFileSearchDirectoryRevealPaths({
        workspacePath,
        directoryPath: row.path,
      });
      if (directoryPathsToExpand.length === 0) {
        return;
      }
      pendingSearchDirectoryRevealPathRef.current = row.path;
      setSelectedPath(row.path);
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        for (const directoryPath of directoryPathsToExpand) {
          next.add(directoryPath);
        }
        return next;
      });
      // 搜索结果是 listWorkspaceFiles 的平铺索引，不受 expandedPaths 驱动。
      // 目录点击必须先回到树态，再逐级加载祖先目录，目标目录才会在懒加载树中可见并保持展开。
      setSearchState(clearWorkspaceFileTreeSearchForDirectoryReveal);
      void (async () => {
        for (const directoryPath of directoryPathsToExpand) {
          await treeData.loadDirectory(
            directoryPath,
            getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, directoryPath),
          );
        }
      })();
    },
    [treeData, workspacePath],
  );
  const handleDirectoryAction = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (showSearchResults) {
        handleRevealSearchDirectory(row);
        return;
      }
      handleToggleDirectory(row);
    },
    [handleRevealSearchDirectory, handleToggleDirectory, showSearchResults],
  );
  const handleOpenPreview = useCallback(
    (row: WorkspaceFileTreeRow, options?: { preview?: boolean }) => {
      if (row.type === "directory") {
        handleDirectoryAction(row);
        return;
      }
      if (
        isWorkspaceFileTreeDeletedFile(
          row,
          getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path),
        )
      ) {
        // 修复：deleted 文件行来自 Git 状态补全，不对应现存文件。
        // 即使未来有其它入口直接调用预览，也要在父级兜底阻止打开。
        return;
      }
      onOpenPreview?.(createCodeViewerSourceForWorkspaceFile(row.path), options);
    },
    [handleDirectoryAction, onOpenPreview, treeData.gitStatusByPath],
  );
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleOpenPreview(row);
        return;
      }
      if (event.key === "ArrowRight" && row.type === "directory") {
        event.preventDefault();
        if (!row.expanded || showSearchResults) {
          handleDirectoryAction(row);
        }
        return;
      }
      if (event.key === "ArrowLeft" && row.type === "directory" && row.expanded) {
        event.preventDefault();
        handleToggleDirectory(row);
      }
    },
    [handleDirectoryAction, handleOpenPreview, handleToggleDirectory, showSearchResults],
  );

  const hasActiveFileTreeFilter = showSearchResults || searchState.changedOnly;
  const virtualItems = rowVirtualizer.getVirtualItems();
  const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
  const stickyFolderItems = useWorkspaceFileTreeStickyFolders({
    rows: visibleRows,
    virtualItems,
    scrollDirection: rowVirtualizer.scrollDirection,
    scrollOffset,
    enabled: hasScrollableFileTree && !showSearchResults,
  });
  const handleRevealStickyFolderRow = useCallback(
    (item: WorkspaceFileTreeStickyFolderItem) =>
      rowVirtualizer.scrollToIndex(item.index, { align: "start" }),
    [rowVirtualizer],
  );
  const workspaceTitle =
    workspaceName?.trim() ||
    getPathLeaf(workspacePath) ||
    intl.formatMessage({ id: "workspaceFileTree.title" });
  const editorState = {
    canOpenLocalFileManager,
    installedEditors: availableEditors,
    isRemoteWorkspaceFileTree,
    remoteTarget,
  };
  const rootActionEntry = {
    path: workspacePath,
    name: workspaceTitle,
    type: "directory" as const,
    root: true,
  };
  const fileActions = useWorkspaceFileActions({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    temporaryExternalDirectory,
    onFailed: () => {
      void treeData.refreshLoadedDirectories();
      refreshSearchIndex();
    },
    onSucceeded: (result, mutation) => {
      setSelectedPath(mutation.kind === "delete" ? null : result.path);
      const plan = planWorkspaceFileTreeMutation({
        workspacePath,
        expandedPaths: treeData.expandedPaths,
        result,
        mutation,
      });
      treeData.setExpandedPaths(plan.expandedPaths);
      // 显式加载迁移后的新目录，不能用仍闭包旧展开集合的刷新请求把已改名路径读回。
      // 同步发起各次读取，让现有 loadDirectory 在旧工作区内捕获同一个 generation。
      for (const path of plan.reloadPaths) {
        void treeData.loadDirectory(
          path,
          getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, path),
          { force: true },
        );
      }
      if (result.changed) void treeData.loadGitStatus();
      refreshSearchIndex();
    },
  });

  // 根操作菜单由文件树持有动作控制器；文件主视图只负责把它放到自己的工作区下拉旁。
  const rootActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          aria-label={intl.formatMessage({ id: "common.more" })}
          title={intl.formatMessage({ id: "common.more" })}
        >
          <Ellipsis className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48"
        onCloseAutoFocus={(event) => {
          if (fileActions.controller.dialogOpen) event.preventDefault();
        }}
      >
        {(["create-file", "create-directory", "paste"] as const).map((action) => (
          <DropdownMenuItem
            key={action}
            disabled={!fileActions.controller.canRun(action, rootActionEntry)}
            onSelect={() => fileActions.controller.run(action, rootActionEntry)}
          >
            {intl.formatMessage({ id: `workspaceFileTree.actions.${action}` })}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canOpenInFileManager}
          onSelect={() => void handleOpenInFileManager()}
        >
          <FolderOpen className="size-4" />
          {fileManagerLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleCopyPath()}>
          <Copy className="size-4" />
          {intl.formatMessage({ id: "appHeader.copyPath" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON}
          disabled={treeData.refreshingLoadedDirectories}
          onSelect={() => handleRefresh()}
        >
          <RefreshCw className={cn("size-4", refreshInProgress && "animate-spin")} />
          {intl.formatMessage({ id: "workspaceFileTree.refresh" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const content = (
    <section
      className="flex h-full min-h-0 flex-col text-foreground"
      data-testid={TID_WORKSPACE_FILE_TREE_PANEL}
    >
      {onClose ? (
        <div className="px-2 pb-3 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full justify-start gap-2 rounded-xl px-2.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onClose}
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "workspaceFileTree.backToTasks" })}
            </span>
          </Button>
        </div>
      ) : null}
      <WorkspaceFileRootMenu entry={rootActionEntry}>
        <div className="shrink-0">
          <WorkspaceFileTreeHeader
            title={workspaceTitle}
            rootActions={rootActions}
            renderHeader={renderHeader}
          />
        </div>
      </WorkspaceFileRootMenu>
      <WorkspaceFileTreeSearchHeader
        state={searchState}
        gitStatusAvailable={treeData.gitStatusAvailable}
        filtering={showSearchResults && (searchIndexLoading || searchResults.filtering)}
        onChange={updateSearchState}
        onClearFilters={clearSearchFilters}
      />
      {showSearchResults && searchResults.hasMore ? (
        <p
          className="shrink-0 px-3 pb-1 text-ui-sm text-foreground-subtlest"
          data-testid="workspace-file-search-truncated"
        >
          {intl.formatMessage(
            { id: "workspaceFileTree.searchResultsTruncated" },
            { count: WORKSPACE_FILE_SEARCH_RESULT_LIMIT },
          )}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspaceFileRootMenu entry={rootActionEntry}>
          <div
            ref={scrollRef}
            className="h-full min-h-0 overflow-auto px-1 px-2"
            style={scrollContainerStyle}
          >
            <WorkspaceFileTreeStickyFolders
              items={stickyFolderItems}
              selectedPath={selectedPath}
              gitStatusByPath={treeData.gitStatusByPath}
              ignoredPathSet={treeData.ignoredPathSet}
              gitStatusLabelByStatus={gitStatusLabelByStatus}
              contextMenuLabels={fileContextMenuLabels}
              editorState={editorState}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              onSelect={setSelectedPath}
              onToggleDirectory={handleToggleDirectory}
              onRetryDirectory={handleRetryDirectory}
              onRevealRow={handleRevealStickyFolderRow}
              onOpenPreview={handleOpenPreview}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onKeyDown={handleRowKeyDown}
            />
            <WorkspaceFileTreeList
              rootError={showSearchResults ? searchIndexError : blockingRootError}
              showInitialLoading={
                showSearchResults
                  ? searchResults.filtering || searchIndexLoading
                    ? !searchIndexLoaded || searchResults.entries.length === 0
                    : false
                  : showInitialLoading
              }
              rows={visibleRows}
              virtualItems={virtualItems}
              listRef={handleListRef}
              stickyFolderCount={stickyFolderItems.length}
              totalSize={rowVirtualizer.getTotalSize()}
              emptyTitle={intl.formatMessage({
                id: hasActiveFileTreeFilter
                  ? "workspaceFileTree.noResults"
                  : "workspaceFileTree.empty",
              })}
              workspaceTitle={workspaceTitle}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              selectedPath={selectedPath}
              gitStatusByPath={treeData.gitStatusByPath}
              ignoredPathSet={treeData.ignoredPathSet}
              gitStatusLabelByStatus={gitStatusLabelByStatus}
              contextMenuLabels={fileContextMenuLabels}
              editorState={editorState}
              onSelect={setSelectedPath}
              onToggleDirectory={handleDirectoryAction}
              onRetryDirectory={handleRetryDirectory}
              onOpenPreview={handleOpenPreview}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onKeyDown={handleRowKeyDown}
            />
          </div>
        </WorkspaceFileRootMenu>
      </div>
    </section>
  );
  return (
    <WorkspaceFileActionContext.Provider value={fileActions.controller}>
      {content}
      <WorkspaceFileActionDialog
        state={fileActions.dialog}
        busy={fileActions.busy}
        onNameChange={fileActions.changeName}
        onSubmit={fileActions.submit}
        onCancel={fileActions.cancel}
      />
    </WorkspaceFileActionContext.Provider>
  );
}

function getWorkspaceFileTreeBlockingRootError({
  rootLoaded,
  rootError,
}: {
  rootLoaded: boolean;
  rootError: Error | null;
}) {
  return rootLoaded ? null : rootError;
}
