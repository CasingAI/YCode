import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isFilesPreviewBuffer, isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import { FilesLargeTextViewer } from "@/files-workbench/FilesLargeTextViewer.js";
import { FilesMarkdownPreview } from "@/files-workbench/FilesMarkdownPreview.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import type {
  FilesBuffer,
  FilesEditorFocusRequest,
  FilesMonacoOpenPath,
  FilesMonacoRevealPosition,
} from "@/files-workbench/filesEditorTypes.js";
import { PreviewPane } from "@/PreviewPane.js";

const FilesMonacoEditor = lazy(async () => {
  const module = await import("@/files-workbench/FilesMonacoEditor.js");
  return { default: module.FilesMonacoEditor };
});

/**
 * 一组编辑器的主体区域：加载态、大文本、Monaco、只读预览与空态。
 *
 * 从 `FilesEditorGroupPane` 拆出，让组外壳只保留标签条、提示条、状态栏与拖放。
 * Markdown 预览在这里以覆盖层呈现，源码编辑器保持挂载并 `inert`，
 * 因此切换模式不丢撤销历史、光标与滚动位置。
 */
export function FilesEditorContent({
  buffer,
  viewId,
  isActiveView,
  markdownPreviewActive,
  loadRestoredTextFile,
  onChange,
  onOpenPath,
  revealPosition,
  onRevealPositionApplied,
  focusRequest,
  onFocusApplied,
  onStatusHandleChange,
  onClose,
  onExternalChangeAction,
}: {
  buffer: FilesBuffer | undefined;
  viewId: string | undefined;
  isActiveView: boolean;
  markdownPreviewActive: boolean;
  loadRestoredTextFile: (id: string) => Promise<void>;
  onChange: (bufferId: string, text: string) => void;
  onOpenPath: FilesMonacoOpenPath;
  revealPosition?: FilesMonacoRevealPosition;
  onRevealPositionApplied: (path: string) => void;
  focusRequest?: FilesEditorFocusRequest;
  onFocusApplied?: (requestId: number) => void;
  onStatusHandleChange: (handle: FilesEditorStatusHandle | null) => void;
  onClose: (bufferId: string, viewId: string) => void;
  onExternalChangeAction: (bufferId: string, action: "reload" | "dismiss") => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden [app-region:no-drag]">
      {buffer &&
      isFilesTextBuffer(buffer) &&
      (buffer.loadState === "unloaded" || buffer.loadState === "loading") ? (
        <div
          className="flex h-full items-center justify-center gap-2 text-ui-sm text-foreground-subtle"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span>{intl.formatMessage({ id: "filesWorkbench.loadingFile" })}</span>
        </div>
      ) : buffer && isFilesTextBuffer(buffer) && buffer.loadState === "error" ? (
        <div
          className="flex h-full flex-col items-center justify-center gap-2 text-center text-ui-sm text-foreground-subtle"
          role="alert"
        >
          <span>{intl.formatMessage({ id: "filesWorkbench.loadFileError" })}</span>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-ui-sm hover:bg-surface-hover"
            onClick={() => void loadRestoredTextFile(buffer.id)}
          >
            {intl.formatMessage({ id: "filesWorkbench.retryLoadFile" })}
          </button>
        </div>
      ) : buffer?.kind === "large-text" ? (
        <FilesLargeTextViewer
          buffer={buffer}
          active={isActiveView}
          onEditorStatusHandleChange={onStatusHandleChange}
          onReloadRequested={() => onExternalChangeAction(buffer.id, "reload")}
        />
      ) : buffer && isFilesTextBuffer(buffer) ? (
        <div className="relative h-full min-h-0 w-full">
          {/* 预览时保持编辑器挂载，覆盖层只换展示：撤销历史、光标与滚动位置都不丢。 */}
          <div
            className="absolute inset-0"
            inert={markdownPreviewActive ? true : undefined}
            aria-hidden={markdownPreviewActive || undefined}
          >
            <Suspense fallback={null}>
              <FilesMonacoEditor
                buffer={buffer}
                onChange={(text) => onChange(buffer.id, text)}
                onOpenPath={onOpenPath}
                revealPosition={revealPosition}
                onRevealPositionApplied={onRevealPositionApplied}
                focusRequest={focusRequest}
                onFocusApplied={onFocusApplied}
                onStatusHandleChange={onStatusHandleChange}
              />
            </Suspense>
          </div>
          {markdownPreviewActive ? (
            <div className="absolute inset-0 z-10 bg-background">
              <FilesMarkdownPreview buffer={buffer} />
            </div>
          ) : null}
        </div>
      ) : buffer && isFilesPreviewBuffer(buffer) ? (
        <PreviewPane
          source={{
            type: "file",
            title: buffer.title,
            path: buffer.path,
            workspacePath: buffer.workspace.workspacePath,
            workspaceIdentity: buffer.workspace.workspaceIdentity,
            workspaceRemoteSessionId: buffer.workspace.workspaceRemoteSessionId,
          }}
          workspacePath={buffer.workspace.workspacePath}
          onClose={() => onClose(buffer.id, viewId ?? "")}
          variant="workbench"
        />
      ) : (
        <p className="px-6 py-12 text-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "filesWorkbench.emptyEditor" })}
        </p>
      )}
    </div>
  );
}
