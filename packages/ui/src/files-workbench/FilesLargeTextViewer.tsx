import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFilesLargeTextWindow } from "@/hooks/useFilesLargeTextWindow.js";
import type {
  FilesLargeTextWindowEditorHandle,
  FilesLargeTextWindowSearchResult,
} from "@/files-workbench/FilesLargeTextWindowEditor.js";
import {
  formatFilesLargeTextByteCount,
  formatFilesLargeTextRange,
  isFilesLargeTextFragment,
  resolveFilesLargeTextPosition,
} from "@/files-workbench/filesLargeTextNavigation.js";
import { FilesLargeTextViewerToolbar } from "@/files-workbench/FilesLargeTextViewerToolbar.js";
import {
  findFilesBuffer,
  hasFilesLargeTextEditChanges,
  isFilesLargeTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import type { FilesLargeTextBlockSlice } from "@/files-workbench/filesLargeTextBlockModel.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import type {
  FilesLargeTextBuffer,
  FilesLargeTextEditState,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 当前块投影：磁盘原块 + Store 中同 offset 的修改。
 *
 * 修改的 `originalText` 必须仍等于当前块正文，否则说明坐标或基准已变化，
 * 此时不能套用旧补丁，也不能继续编辑该块。
 */
export function resolveFilesLargeTextBlockProjection(params: {
  block: FilesLargeTextBlockSlice | null;
  edit: FilesLargeTextEditState | undefined;
  version: string | undefined;
}): {
  content: string;
  editable: boolean;
  dirty: boolean;
  applied: boolean;
} {
  const { block, edit, version } = params;
  const dirty = hasFilesLargeTextEditChanges(edit);
  if (!block) return { content: "", editable: false, dirty, applied: false };
  const change = edit?.changes.find((item) => item.offset === block.offset);
  const versionMatches =
    edit !== undefined && version !== undefined && edit.baseVersion === version;
  const applied = Boolean(versionMatches && change && change.originalText === block.content);
  const content = applied ? (change?.text ?? block.content) : block.content;
  const editable =
    versionMatches &&
    !block.hasDecodingErrors &&
    !block.needsExactConfirmation &&
    (!change || applied);
  return { content, editable, dirty, applied };
}

// Monaco 只在真正拿到窗口后加载；结构测试与隐藏保活不引入编辑器运行时。
const FilesLargeTextWindowEditor = lazy(async () => {
  const module = await import("@/files-workbench/FilesLargeTextWindowEditor.js");
  return { default: module.FilesLargeTextWindowEditor };
});

/**
 * 解码提示：
 * - `readonlyReason === "encoding"` 只说明部分块可能无法无损解码；
 *   具体只读范围由各块的 `hasDecodingErrors` 决定，其它块仍可编辑保存；
 * - 当前块 `hasDecodingErrors` 只说明本块，不推断全文件位置。
 */
export function FilesLargeTextDecodingNotices({
  readonlyReason,
  hasDecodingErrors,
}: {
  readonlyReason?: "encoding";
  hasDecodingErrors: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (readonlyReason !== "encoding" && !hasDecodingErrors) return null;
  return (
    <>
      {readonlyReason === "encoding" ? (
        <p
          role="note"
          data-files-large-text-encoding=""
          className="shrink-0 border-b border-warning/40 bg-warning/10 px-2 py-1.5 text-ui-base text-foreground"
        >
          {intl.formatMessage({ id: "filesWorkbench.largeText.encodingBlockReadonly" })}
        </p>
      ) : null}
      {hasDecodingErrors ? (
        <p
          data-files-large-text-decoding-errors=""
          className="shrink-0 border-b border-border/60 bg-surface-hover px-2 py-1 text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "filesWorkbench.largeText.windowDecodingErrors" })}
        </p>
      ) : null}
    </>
  );
}

/**
 * `> 8 MiB` 文本的固定块视图。
 *
 * 当前磁盘原块由 buffer 作用域的 range store 持有；未保存修改只存在于
 * Files Editor Store 的 `edit.changes`，本组件按当前块 offset 投影。
 * 非法字节块只读，但同 buffer 的其它合法块仍可编辑。
 */
export function FilesLargeTextViewer({
  buffer,
  active,
  onEditorStatusHandleChange,
  onReloadRequested,
}: {
  buffer: FilesLargeTextBuffer;
  /** 文件主视图可见且已进入过文件视图；隐藏保活时为 false，不额外读盘。 */
  active: boolean;
  /**
   * 与普通文本同形的菜单句柄；GroupPane 接管后即可让全局撤销 / 查找菜单
   * 路由到当前大文件块。未接线时编辑器内部快捷键仍可用。
   */
  onEditorStatusHandleChange?: (handle: FilesEditorStatusHandle | null) => void;
  /**
   * 脏草稿点击刷新时的外部确认入口。Viewer 不会直接重新请求并覆盖补丁；
   * 由 controller 弹出确认，再决定重载或保留。
   */
  onReloadRequested?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const filesEditorStore = useFilesEditorStoreApi();
  const edit = useFilesEditorStore((state) => {
    const current = findFilesBuffer(state, buffer.id);
    return current && isFilesLargeTextBuffer(current) ? current.edit : undefined;
  });
  const { snapshot, navigate, refresh, retry } = useFilesLargeTextWindow(buffer, active);
  const [percentInput, setPercentInput] = useState("");
  const [offsetInput, setOffsetInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchResult, setSearchResult] = useState<FilesLargeTextWindowSearchResult | null>(null);
  const editorRef = useRef<FilesLargeTextWindowEditorHandle | null>(null);

  const window = snapshot.window;
  const block = snapshot.block;
  const totalBytes = window?.totalBytes ?? buffer.totalBytes ?? 0;
  const offset = block?.offset ?? window?.offset ?? 0;
  const nextOffset = block?.nextOffset ?? window?.nextOffset ?? offset;
  const eof = window ? nextOffset >= window.totalBytes : false;
  const fragment = window ? isFilesLargeTextFragment({ offset, eof }) : false;
  const position = window
    ? resolveFilesLargeTextPosition({ offset, nextOffset, totalBytes, eof })
    : null;
  const loading = snapshot.phase === "loading";
  const canNavigate = Boolean(window) && !loading;
  // 首块没有上一块；最后一块继续向后会 clamp 在同一块，交互层直接禁用。
  const firstBlock = block?.blockIndex === 0;
  const canGoPrevious = canNavigate && !firstBlock;
  const canGoNext = canNavigate && window !== null && !eof;
  const error = snapshot.error;
  const projection = resolveFilesLargeTextBlockProjection({
    block,
    edit,
    version: window?.version,
  });
  const content = projection.content;
  // Store 的 saveToken 表示补丁提交进行中：各 split 同步只读，
  // 阻止继续输入 / 撤销 / 重做，也阻止刷新在提交完成前替换当前块。
  const saving = Boolean(buffer.saveToken);
  const editable = projection.editable;
  const editorEditable = editable && !saving;
  const dirty = projection.dirty;
  const requestRefresh = () => {
    if (saving) return;
    if (dirty) {
      // 脏草稿不能静默刷新并替换基准；交给 controller 做外部确认。
      onReloadRequested?.();
      return;
    }
    refresh();
  };

  useEffect(() => {
    const percent = totalBytes > 0 ? Math.round((offset / totalBytes) * 100) : 0;
    setPercentInput(String(percent));
    setOffsetInput(String(offset));
    setSearchResult(null);
  }, [offset, snapshot.revision, totalBytes]);

  const submitSearch = (direction: "next" | "previous") => {
    const query = searchInput;
    if (query === "") {
      setSearchResult(null);
      return;
    }
    const result = editorRef.current?.search(query, direction);
    setSearchResult(result ?? { matches: 0, index: 0 });
  };

  const positionLabel =
    position === "empty"
      ? intl.formatMessage({ id: "filesWorkbench.largeText.position.empty" })
      : position === "middle"
        ? intl.formatMessage({ id: "filesWorkbench.largeText.position.middle" })
        : position === "tail"
          ? intl.formatMessage({ id: "filesWorkbench.largeText.position.tail" })
          : position === "head"
            ? intl.formatMessage({ id: "filesWorkbench.largeText.position.head" })
            : null;

  const errorMessage =
    error?.kind === "changed"
      ? intl.formatMessage({ id: "filesWorkbench.largeText.changed" })
      : error?.kind === "binary"
        ? intl.formatMessage({ id: "filesWorkbench.largeText.binary" })
        : error?.kind === "offline"
          ? intl.formatMessage({ id: "filesWorkbench.largeText.offline" })
          : error?.kind === "failed"
            ? intl.formatMessage({ id: "filesWorkbench.largeText.loadFailed" })
            : null;

  const searchLabel =
    searchResult === null
      ? null
      : searchResult.matches === 0
        ? intl.formatMessage({ id: "filesWorkbench.largeText.searchNoMatch" })
        : intl.formatMessage(
            { id: "filesWorkbench.largeText.searchResult" },
            { index: searchResult.index, count: searchResult.matches },
          );

  return (
    <section
      data-files-large-text-viewer=""
      data-buffer-id={buffer.id}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden [app-region:no-drag]"
    >
      <FilesLargeTextViewerToolbar
        canNavigate={canNavigate}
        canGoPrevious={canGoPrevious}
        canGoNext={canGoNext}
        hasWindow={Boolean(window)}
        loading={loading}
        percentInput={percentInput}
        offsetInput={offsetInput}
        searchInput={searchInput}
        searchLabel={searchLabel}
        editable={editable}
        dirty={dirty}
        onPercentInputChange={setPercentInput}
        onOffsetInputChange={setOffsetInput}
        onSearchInputChange={(value) => {
          setSearchInput(value);
          setSearchResult(null);
        }}
        onNavigate={navigate}
        onRefresh={requestRefresh}
        onSearch={submitSearch}
      />

      <div
        role="status"
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border/60 px-2 py-1 text-ui-base text-foreground-subtle"
      >
        {window ? (
          <>
            <span
              data-files-large-text-range=""
              className="font-mono text-foreground"
              title={formatFilesLargeTextRange({ offset, nextOffset })}
            >
              {formatFilesLargeTextRange({ offset, nextOffset })}
            </span>
            <span data-files-large-text-total="">
              {intl.formatMessage(
                { id: "filesWorkbench.largeText.total" },
                { size: formatFilesLargeTextByteCount(totalBytes), bytes: totalBytes },
              )}
            </span>
            {positionLabel ? <span>{positionLabel}</span> : null}
            {fragment ? (
              <span className="rounded-sm bg-surface-hover px-1.5 py-0.5">
                {intl.formatMessage({ id: "filesWorkbench.largeText.fragment" })}
              </span>
            ) : null}
            {saving ? (
              <span
                role="status"
                aria-live="polite"
                data-files-large-text-saving=""
                className="rounded-sm border border-border px-1.5 py-0.5"
              >
                {intl.formatMessage({ id: "filesWorkbench.largeText.saving" })}
              </span>
            ) : null}
          </>
        ) : (
          <span>
            {intl.formatMessage(
              { id: "filesWorkbench.largeText.totalOnly" },
              { size: formatFilesLargeTextByteCount(totalBytes), bytes: totalBytes },
            )}
          </span>
        )}
        <span>{intl.formatMessage({ id: "filesWorkbench.largeText.searchScoped" })}</span>
        <span>{intl.formatMessage({ id: "filesWorkbench.largeText.noWholeFileLineNumbers" })}</span>
      </div>

      <FilesLargeTextDecodingNotices
        readonlyReason={buffer.readonlyReason}
        hasDecodingErrors={block?.hasDecodingErrors === true}
      />

      {errorMessage && window ? (
        <div
          role="alert"
          data-files-large-text-error={error?.kind}
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-2 py-1.5 text-ui-base text-foreground"
        >
          {dirty && error?.kind === "changed" ? (
            <span data-files-large-text-dirty-external="">
              {intl.formatMessage({ id: "filesWorkbench.largeText.dirtyExternalChange" })}
            </span>
          ) : (
            <span>{errorMessage}</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={saving}
            onClick={
              error?.kind === "changed"
                ? requestRefresh
                : error?.kind === "binary"
                  ? refresh
                  : retry
            }
          >
            {error?.kind === "changed" || error?.kind === "binary"
              ? intl.formatMessage({ id: "filesWorkbench.largeText.refresh" })
              : intl.formatMessage({ id: "filesWorkbench.largeText.retry" })}
          </Button>
        </div>
      ) : null}

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {loading && !window ? (
          <div
            role="status"
            aria-live="polite"
            className="flex h-full items-center justify-center gap-2 text-ui-sm text-foreground-subtle"
          >
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            <span>{intl.formatMessage({ id: "filesWorkbench.largeText.loading" })}</span>
          </div>
        ) : window ? (
          <Suspense fallback={null}>
            <FilesLargeTextWindowEditor
              ref={editorRef}
              bufferId={buffer.id}
              content={content}
              path={buffer.path}
              revision={snapshot.revision}
              label={intl.formatMessage({ id: "filesWorkbench.largeText.editorLabel" })}
              editable={editorEditable}
              onChange={(text) => {
                if (!block) return;
                filesEditorStore.getState().updateLargeTextBlock(
                  buffer.id,
                  {
                    blockIndex: block.blockIndex,
                    offset: block.offset,
                    deleteBytes: Math.max(0, block.nextOffset - block.offset),
                    originalText: block.content,
                    hasDecodingErrors: block.hasDecodingErrors,
                  },
                  text,
                );
              }}
              onUndo={() => filesEditorStore.getState().undoLargeTextEdit(buffer.id)}
              onRedo={() => filesEditorStore.getState().redoLargeTextEdit(buffer.id)}
              onStatusHandleChange={onEditorStatusHandleChange}
            />
          </Suspense>
        ) : snapshot.phase === "error" ? (
          <div
            role="alert"
            className="flex h-full flex-col items-center justify-center gap-2 text-center text-ui-sm text-foreground-subtle"
          >
            <span>{errorMessage}</span>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              {intl.formatMessage({ id: "filesWorkbench.largeText.retry" })}
            </Button>
          </div>
        ) : (
          <p className="px-6 py-12 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "filesWorkbench.largeText.empty" })}
          </p>
        )}
      </div>
    </section>
  );
}
