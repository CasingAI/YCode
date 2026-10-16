import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { TID_FILES_WORKBENCH } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PreviewPane } from "@/PreviewPane.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  filesBufferTabTitle,
  findFilesBuffer,
  isFilesPreviewBuffer,
  isFilesTextBuffer,
  resolveExplorerWorkspaceKey,
} from "@/files-workbench/filesEditorModel.js";
import { FilesEditorTabBar } from "@/files-workbench/FilesEditorTabBar.js";
import {
  FilesConflictDialog,
  FilesDirtyCloseDialog,
} from "@/files-workbench/FilesWorkbenchDialogs.js";
import { FilesSaveAsDialog } from "@/files-workbench/FilesSaveAsDialog.js";
import {
  filesExplorerWorkspaceOptions,
  findFilesExplorerWorkspaceOption,
} from "@/files-workbench/filesExplorerWorkspace.js";
import {
  filesActiveTextBuffer,
  useFilesWorkbenchController,
} from "@/files-workbench/useFilesWorkbenchController.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";

const FilesMonacoEditor = lazy(async () => {
  const module = await import("@/files-workbench/FilesMonacoEditor.js");
  return { default: module.FilesMonacoEditor };
});

export function FilesWorkbenchSurface({
  isActiveView,
  isDesktop = false,
}: {
  isActiveView: boolean;
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const store = useFilesEditorStoreApi();
  const buffers = useFilesEditorStore((state) => state.buffers);
  const openIds = useFilesEditorStore((state) => state.openIds);
  const activeId = useFilesEditorStore((state) => state.activeId);
  const pendingSaveDirectory = useFilesEditorStore((state) => state.pendingSaveDirectory);
  const explorerWorkspaceKey = useFilesEditorStore((state) => state.explorerWorkspaceKey);
  const workspaceTabs = useTabStore(useShallow((state) => state.tabs.filter(isWorkspaceTab)));
  const [hasEnteredFiles, setHasEnteredFiles] = useState(isActiveView);
  const controller = useFilesWorkbenchController(hasEnteredFiles);
  useEffect(() => {
    if (isActiveView) {
      setHasEnteredFiles(true);
    }
  }, [isActiveView]);
  const openBuffers = useMemo(
    () =>
      openIds.flatMap((id) => {
        const buffer = findFilesBuffer({ buffers, openIds, untitledSerial: 1 }, id);
        return buffer ? [buffer] : [];
      }),
    [buffers, openIds],
  );
  const activeBuffer = openBuffers.find((buffer) => buffer.id === activeId);
  const loadRestoredTextFile = controller.loadRestoredTextFile;
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
  const untitledWorkspace = useMemo(() => {
    const options = filesExplorerWorkspaceOptions(workspaceTabs);
    const selectedKey = resolveExplorerWorkspaceKey({
      preferredKey: explorerWorkspaceKey,
      workspaceKeys: options.map((option) => option.key),
    });
    return findFilesExplorerWorkspaceOption(options, selectedKey)?.workspace;
  }, [explorerWorkspaceKey, workspaceTabs]);
  const dirtyCloseBuffer = controller.dirtyCloseBufferId
    ? findFilesBuffer({ buffers, openIds, untitledSerial: 1 }, controller.dirtyCloseBufferId)
    : undefined;
  const saveAsBuffer = controller.saveAsBufferId
    ? filesActiveTextBuffer(buffers, controller.saveAsBufferId)
    : undefined;

  useEffect(() => {
    if (!isActiveView) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }
      event.preventDefault();
      const buffer = filesActiveTextBuffer(store.getState().buffers, store.getState().activeId);
      if (buffer) {
        void controller.saveTextBuffer(buffer);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, isActiveView, store]);

  return (
    <section
      className="flex h-full min-h-0 flex-col [app-region:no-drag]"
      data-testid={TID_FILES_WORKBENCH}
    >
      {/* 与左栏顶栏、会话 Header 齐高。整层只负责拖窗口，标签条必须在这层下面。 */}
      <div
        aria-hidden="true"
        className={cn("h-12 shrink-0", isDesktop && isActiveView && "[app-region:drag]")}
      />
      {/* handler 稳定引用：TabBar 的单个 tab 已 memo 化，内联箭头会每次渲染击穿 memo，
          在数百个恢复的 tab 下放大成全列表重算（2026-10-15 启动冻结）。 */}
      <FilesEditorTabBar
        buffers={openBuffers}
        activeId={activeId}
        onActivate={useCallback((id: string) => store.getState().setActiveId(id), [store])}
        onKeepOpen={useCallback(
          (id: string) => {
            const buffer = findFilesBuffer(store.getState(), id);
            if (!buffer) {
              return;
            }
            store.getState().openBuffer(buffer, "keep");
            controller.persist();
          },
          [controller, store],
        )}
        onClose={useCallback(
          (id: string) => {
            void controller.closeBuffer(id);
          },
          [controller],
        )}
        onCloseOthers={useCallback(
          (id: string) => {
            void controller.closeOtherBuffers(id);
          },
          [controller],
        )}
        onCreateUntitled={useCallback(() => {
          if (!untitledWorkspace) {
            return;
          }
          store.getState().createUntitled(untitledWorkspace);
          controller.persist();
        }, [controller, store, untitledWorkspace])}
      />
      <div className="min-h-0 flex-1 [app-region:no-drag]">
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
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadRestoredTextFile(activeBuffer.id)}
            >
              {intl.formatMessage({ id: "filesWorkbench.retryLoadFile" })}
            </Button>
          </div>
        ) : hasEnteredFiles && activeBuffer && isFilesTextBuffer(activeBuffer) ? (
          <Suspense fallback={null}>
            <FilesMonacoEditor
              buffer={activeBuffer}
              onChange={(text) => {
                const current = findFilesBuffer(store.getState(), activeBuffer.id);
                if (current && isFilesTextBuffer(current) && current.text === text) {
                  return;
                }
                store.getState().updateText(activeBuffer.id, text);
                controller.persist();
              }}
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
            onClose={() => undefined}
            variant="workbench"
          />
        ) : (
          <p className="px-6 py-12 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "filesWorkbench.emptyEditor" })}
          </p>
        )}
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
        onCancel={() => controller.setSaveAsBufferId(undefined)}
        onConfirm={(path) => {
          if (!saveAsBuffer) {
            return;
          }
          controller.setSaveAsBufferId(undefined);
          void controller.saveTextBuffer(saveAsBuffer, { path, force: true });
        }}
      />
    </section>
  );
}
