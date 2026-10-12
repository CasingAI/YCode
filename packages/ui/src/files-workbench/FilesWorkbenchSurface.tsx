import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { TID_FILES_EDITOR_TAB, TID_FILES_WORKBENCH, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PreviewPane } from "@/PreviewPane.js";
import {
  filesBufferTabTitle,
  filesBufferTabTooltip,
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesPreviewBuffer,
  isFilesTextBuffer,
  needsFilesWorkspaceDisambiguation,
} from "@/files-workbench/filesEditorModel.js";
import {
  FilesConflictDialog,
  FilesDirtyCloseDialog,
} from "@/files-workbench/FilesWorkbenchDialogs.js";
import { FilesSaveAsDialog } from "@/files-workbench/FilesSaveAsDialog.js";
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
}: {
  isActiveView: boolean;
}) {
  const { intl } = useZCodeIntl();
  const store = useFilesEditorStoreApi();
  const buffers = useFilesEditorStore((state) => state.buffers);
  const openIds = useFilesEditorStore((state) => state.openIds);
  const activeId = useFilesEditorStore((state) => state.activeId);
  const pendingSaveDirectory = useFilesEditorStore((state) => state.pendingSaveDirectory);
  const controller = useFilesWorkbenchController();
  const [hasEnteredFiles, setHasEnteredFiles] = useState(isActiveView);
  useEffect(() => {
    if (isActiveView) {
      setHasEnteredFiles(true);
    }
  }, [isActiveView]);
  const openBuffers = useMemo(
    () => openIds.flatMap((id) => {
      const buffer = findFilesBuffer({ buffers, openIds, untitledSerial: 1 }, id);
      return buffer ? [buffer] : [];
    }),
    [buffers, openIds],
  );
  const activeBuffer = openBuffers.find((buffer) => buffer.id === activeId);
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
    <section className="flex h-full min-h-0 flex-col" data-testid={TID_FILES_WORKBENCH}>
      <div className="flex shrink-0 overflow-x-auto border-b border-border">
        {openBuffers.map((buffer) => {
          const selected = buffer.id === activeId;
          const disambiguate = needsFilesWorkspaceDisambiguation(openBuffers, buffer);
          return (
            <button
              key={buffer.id}
              type="button"
              data-testid={testId(TID_FILES_EDITOR_TAB, buffer.id)}
              title={filesBufferTabTooltip(buffer)}
              className={cn(
                "flex max-w-56 shrink-0 items-center gap-1 border-r border-border px-3 py-1.5 text-ui-sm",
                selected ? "bg-card-selected text-foreground" : "text-foreground-subtle hover:bg-surface-hover",
              )}
              onClick={() => store.getState().setActiveId(buffer.id)}
            >
              <span className="min-w-0 truncate">
                {isFilesBufferDirty(buffer) ? "● " : ""}
                {filesBufferTabTitle(buffer)}
                {disambiguate ? ` — ${filesBufferTabTooltip(buffer).split(" — ").at(-1)}` : ""}
              </span>
              <span
                role="button"
                tabIndex={0}
                className="rounded p-0.5 hover:bg-surface-hover"
                onClick={(event) => {
                  event.stopPropagation();
                  void controller.closeBuffer(buffer.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    void controller.closeBuffer(buffer.id);
                  }
                }}
              >
                <X className="size-3" />
              </span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {hasEnteredFiles && activeBuffer && isFilesTextBuffer(activeBuffer) ? (
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
        ) : activeBuffer && isFilesPreviewBuffer(activeBuffer) ? (
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
