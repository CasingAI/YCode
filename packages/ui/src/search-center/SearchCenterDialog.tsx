import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command.js";
import { useFilesEditorStore } from "@/files-workbench/FilesEditorStoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import { QuickPickSearchDialog } from "@/quickpick/QuickPickSearchDialog.js";
import { quickPickItemClassName, quickPickMetadataClassName } from "@/quickpick/quickPickStyles.js";
import { buildSearchCenterOpenedFiles } from "@/search-center/searchCenterOpenedFiles.js";
import {
  resolveSearchCenterRows,
  resolveSearchCenterSelection,
  type SearchCenterRow,
} from "@/search-center/searchCenterState.js";
import { useSearchCenterFileSearch } from "@/search-center/useSearchCenterFileSearch.js";

function getRowDirectory(relativePath: string): string {
  const slashIndex = relativePath.lastIndexOf("/");
  return slashIndex === -1 ? "" : relativePath.slice(0, slashIndex);
}

/**
 * 搜索中心（⌘P 快速打开）。
 *
 * 与命令中心是**两个平级的浮层**：外观与键盘交互共用命令中心的搜索浮层外壳，
 * 但查询状态、结果列表、历史与 AI 搜索都不共用。
 *
 * 落点也不同：这里确认后走文件工作台的打开链路（filesEditorStore.requestOpenPath），
 * 而不是命令中心的只读代码查看器。
 */
export function SearchCenterDialog({
  open,
  onOpenChange,
  workspaceAbsPath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  focusRequestId,
  onOpenFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  /** 浮层已打开时再次按 ⌘P：递增后把焦点交回输入框并全选查询。 */
  focusRequestId: number;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
}) {
  const { intl } = useZCodeIntl();
  const [rawQuery, setRawQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 确认打开与取消要区分：确认后焦点交给目标编辑器，取消才恢复原焦点。
  const confirmedRef = useRef(false);
  const buffers = useFilesEditorStore((state) => state.buffers);
  const openIds = useFilesEditorStore((state) => state.openIds);
  const activeId = useFilesEditorStore((state) => state.activeId);

  const search = useSearchCenterFileSearch({
    enabled: open,
    workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId,
    remoteTarget,
    query: rawQuery,
  });

  // 每次打开都从空查询开始；关闭时也清掉查询，不留到下一次。
  useEffect(() => {
    confirmedRef.current = false;
    setRawQuery("");
  }, [open]);

  // 浮层已打开时再按 ⌘P：不叠新实例，把焦点交回自己的输入框并全选查询。
  useEffect(() => {
    if (!open || focusRequestId <= 0) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [focusRequestId, open]);

  const trimmedQuery = rawQuery.trim();
  // 结果必须属于当前查询才算「已落定」：防抖窗口内、以及新查询在途时都不给可选项，
  // 否则回车会打开上一个查询的旧结果。空查询不需要结果，直接算落定。
  const settled =
    !trimmedQuery ||
    (search.resultsQuery === trimmedQuery &&
      search.pathResultsQuery === trimmedQuery &&
      // 粘贴路径的存在性检查在途时也不给可选项：回车不能退化成打开一个模糊匹配结果。
      search.pathStatus !== "checking");
  // 路径候选必须属于当前查询，否则它是上一次查询留下的结果。
  const pathCandidate =
    settled && search.pathResultsQuery === trimmedQuery ? search.pathCandidate : null;
  const pathNotice =
    trimmedQuery && search.pathResultsQuery === trimmedQuery
      ? search.pathStatus === "missing"
        ? intl.formatMessage(
            { id: "searchCenter.pathMissing" },
            { path: search.pathAbsolutePath ?? trimmedQuery },
          )
        : search.pathStatus === "directory"
          ? intl.formatMessage(
              { id: "searchCenter.pathIsDirectory" },
              { path: search.pathAbsolutePath ?? trimmedQuery },
            )
          : null
      : null;

  const openedFiles = useMemo(
    () =>
      buildSearchCenterOpenedFiles({
        buffers,
        openIds,
        activeId,
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
      }),
    [activeId, buffers, openIds, workspaceAbsPath, workspaceIdentity],
  );

  const resolvedRows = useMemo<SearchCenterRow[]>(
    () =>
      resolveSearchCenterRows({
        trimmedQuery,
        resultsQuery: search.resultsQuery,
        entries: search.entries.map((entry) => ({
          path: entry.path,
          name: entry.name,
          relativePath: entry.relativePath,
        })),
        openedFiles,
        pathCandidate,
      }),
    [openedFiles, pathCandidate, search.entries, search.resultsQuery, trimmedQuery],
  );

  // 没落定之前一律不给可选项：粘贴路径的存在性检查在途时，
  // 回车不能退化成打开一个模糊匹配结果。
  const rows = settled ? resolvedRows : [];

  const handleSelect = useCallback(
    (row: SearchCenterRow) => {
      const outcome = resolveSearchCenterSelection(row);
      if (!outcome.confirmed || !outcome.entry) {
        return;
      }
      confirmedRef.current = true;
      onOpenChange(false);
      onOpenFile(outcome.entry);
    },
    [onOpenChange, onOpenFile],
  );

  const handleCloseAutoFocus = useCallback((event: Event) => {
    if (confirmedRef.current) {
      // 确认打开后焦点要交给目标编辑器，取消这次默认的焦点恢复。
      event.preventDefault();
    }
  }, []);

  const loading = search.loading || !settled;

  const renderRow = (row: SearchCenterRow) => {
    const descriptor = resolveFileDisplayDescriptor(row.path);
    const directory = getRowDirectory(row.relativePath);
    return (
      <CommandItem
        key={row.path}
        value={`${row.name} ${row.relativePath}`}
        className={quickPickItemClassName}
        onSelect={() => handleSelect(row)}
      >
        <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <HighlightedMatchText text={row.name} query={trimmedQuery} />
        </span>
        {directory ? (
          <CommandShortcut className={quickPickMetadataClassName}>
            <HighlightedMatchText text={directory} query={trimmedQuery} />
          </CommandShortcut>
        ) : null}
      </CommandItem>
    );
  };

  const fileRows = pathCandidate ? rows.filter((row) => row !== pathCandidate) : rows;

  const renderEmpty = () => {
    if (loading) {
      // 还在查：加载圈已经在输入框右侧，这里不报「没有找到」，免得把在途说成空结果。
      return null;
    }
    if (search.error) {
      return (
        <CommandEmpty className="px-4 py-5 text-destructive">
          <p>{intl.formatMessage({ id: "searchCenter.error" }, { error: search.error })}</p>
          <button
            type="button"
            className="mt-2 text-ui-base underline underline-offset-4"
            onClick={search.retry}
          >
            {intl.formatMessage({ id: "searchCenter.retry" })}
          </button>
        </CommandEmpty>
      );
    }
    if (search.waitingForConnection) {
      return (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {intl.formatMessage({ id: "searchCenter.waitingForConnection" })}
        </CommandEmpty>
      );
    }
    if (pathNotice) {
      // 粘贴的路径不存在 / 是目录：说清楚这件事，不要说成「没有匹配的文件」。
      return (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {pathNotice}
        </CommandEmpty>
      );
    }
    if (!trimmedQuery) {
      return (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {intl.formatMessage({ id: "searchCenter.hint" })}
        </CommandEmpty>
      );
    }
    return (
      <CommandEmpty className="px-4 py-5 text-foreground-subtle">
        {intl.formatMessage({ id: "searchCenter.noResults" })}
      </CommandEmpty>
    );
  };

  return (
    <QuickPickSearchDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "searchCenter.title" })}
      description={intl.formatMessage({ id: "searchCenter.description" })}
      placeholder={intl.formatMessage({ id: "searchCenter.placeholder" })}
      value={rawQuery}
      onValueChange={setRawQuery}
      loading={loading}
      inputRef={inputRef}
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      {rows.length > 0 ? (
        <>
          {pathNotice ? (
            <div className="px-4 py-2 text-ui-base text-foreground-subtle">{pathNotice}</div>
          ) : null}
          {pathCandidate ? (
            <CommandGroup heading={intl.formatMessage({ id: "searchCenter.section.path" })}>
              {renderRow(pathCandidate)}
            </CommandGroup>
          ) : null}
          {fileRows.length > 0 ? (
            <CommandGroup
              heading={intl.formatMessage({
                id: trimmedQuery ? "searchCenter.section.files" : "searchCenter.section.opened",
              })}
            >
              {fileRows.map(renderRow)}
            </CommandGroup>
          ) : null}
        </>
      ) : (
        renderEmpty()
      )}
    </QuickPickSearchDialog>
  );
}
