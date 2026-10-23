import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { useFilesEditorStoreApi } from "@/files-workbench/FilesEditorStoreProvider.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { useWorkspaceFileActionStore } from "@/store/workspaceFileActionStore.js";
import {
  canPasteWorkspaceFile,
  canRunWorkspaceFileAction,
  getWorkspaceFileActionKey,
  getWorkspaceFileNameError,
  type WorkspaceFileAction,
} from "@/workspace-file-tree/fileActionRules.js";
import type {
  WorkspaceFileActionController,
  WorkspaceFileActionDialogState,
  WorkspaceFileActionEntry,
} from "@/workspace-file-tree/fileActionTypes.js";
import { areWorkspaceFilePathsEqual } from "@/workspace-file-tree/model.js";
import {
  runWorkspaceFileMutation,
  type WorkspaceFileMutation,
  type WorkspaceFileMutationResult,
} from "@/workspace-file-tree/workspaceFileActionRunner.js";

export function useWorkspaceFileActions(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  temporaryExternalDirectory: boolean;
  onSucceeded: (result: WorkspaceFileMutationResult, mutation: WorkspaceFileMutation) => void;
  onFailed: () => void;
}) {
  const { intl } = useZCodeIntl();
  const editorStore = useFilesEditorStoreApi();
  const tabStore = useTabStoreApi();
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.workspaceRemoteSessionId,
    options.workspaceIdentity,
  );
  const readOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, options.workspacePath, options.workspaceIdentity),
  );
  const workspace = useMemo<FilesWorkspaceRef>(
    () => ({
      workspacePath: options.workspacePath,
      workspaceIdentity: options.workspaceIdentity,
      workspaceRemoteSessionId: resolution.remoteSessionId ?? undefined,
    }),
    [options.workspaceIdentity, options.workspacePath, resolution.remoteSessionId],
  );
  const target = useMemo(
    () => ({ ...workspace, remoteSessionId: workspace.workspaceRemoteSessionId }),
    [workspace],
  );
  const scopeKey = getWorkspaceFileActionKey(target);
  const scopeToken = useMemo(() => ({}), [scopeKey]);
  const clipboard = useWorkspaceFileActionStore((state) => state.clipboard);
  const busy = useWorkspaceFileActionStore((state) => state.busyWorkspaceKeys.includes(scopeKey));
  const [dialog, setDialog] = useState<WorkspaceFileActionDialogState | null>(null);
  const nextDialogId = useRef(0);
  const currentScope = useRef<object | null>(scopeToken);
  const currentSuccess = useRef(options.onSucceeded);
  const currentFailure = useRef(options.onFailed);
  currentScope.current = scopeToken;
  currentSuccess.current = options.onSucceeded;
  currentFailure.current = options.onFailed;
  useEffect(() => {
    currentScope.current = scopeToken;
    setDialog(null);
    return () => {
      if (currentScope.current === scopeToken) currentScope.current = null;
    };
  }, [scopeToken]);

  const canRun = useCallback(
    (action: WorkspaceFileAction, entry: WorkspaceFileActionEntry) =>
      canRunWorkspaceFileAction(action, entry, {
        workspace: target,
        rpcReady: resolution.rpcReady,
        readOnly,
        temporaryExternalDirectory: options.temporaryExternalDirectory,
        busy,
        clipboard,
      }),
    [busy, clipboard, options.temporaryExternalDirectory, readOnly, resolution.rpcReady, target],
  );

  const execute = useCallback(
    async (mutation: WorkspaceFileMutation, dialogId?: number, clipboardId?: string) => {
      try {
        const result = await runWorkspaceFileMutation({
          workspace,
          fileService: resolution.services.fileService,
          editorStore,
          mutation,
          clipboardId,
        });
        // 变更属于发起时的工作区；切换后的界面不能消费旧操作的打开和表单结果。
        if (currentScope.current !== scopeToken) return;
        if (dialogId !== undefined) {
          setDialog((current) => (current?.id === dialogId ? null : current));
        }
        currentSuccess.current(result, mutation);
        if (mutation.kind === "create-file") {
          editorStore
            .getState()
            .requestOpenPath({ workspace, path: result.path, preview: false, focus: true });
          tabStore.getState().openFilesTab();
        }
      } catch (error) {
        logger.warn("[workspace-file-actions] 文件操作失败", { kind: mutation.kind, error });
        if (currentScope.current !== scopeToken) return;
        // 递归文件操作可能被系统中断；刷新磁盘投影，但失败不能提前迁移编辑器草稿。
        currentFailure.current();
        const detail = error instanceof Error ? error.message : String(error);
        const errorId =
          detail === "workspace-file-operation-busy"
            ? "workspaceFileTree.actions.busy"
            : detail === "workspace-target-exists" || detail.includes("EEXIST")
              ? "workspaceFileTree.actions.targetExists"
              : detail.includes("ENOENT")
                ? "workspaceFileTree.actions.missing"
                : detail.includes("EACCES") || detail.includes("EPERM")
                  ? "workspaceFileTree.actions.permission"
                  : detail === "workspace-copy-entry-conflict"
                    ? "workspaceFileTree.actions.copyConflict"
                    : detail === "workspace-directory-self-nesting"
                      ? "workspaceFileTree.actions.cannotNest"
                      : detail.includes("EXDEV")
                        ? "workspaceFileTree.actions.crossDevice"
                        : null;
        const message = errorId
          ? intl.formatMessage({ id: errorId })
          : intl.formatMessage({ id: "workspaceFileTree.actions.failed" }, { error: detail });
        if (dialogId !== undefined) {
          setDialog((current) =>
            current?.id === dialogId ? { ...current, error: message } : current,
          );
        } else {
          toast(message, { variant: "warning" });
        }
      }
    },
    [editorStore, intl, resolution.services.fileService, scopeToken, tabStore, workspace],
  );

  const run = useCallback(
    (action: WorkspaceFileAction, entry: WorkspaceFileActionEntry) => {
      if (!canRun(action, entry)) return;
      if (action === "copy" || action === "cut") {
        useWorkspaceFileActionStore.getState().setClipboard({
          ...target,
          path: entry.path,
          type: entry.type,
          name: entry.name,
          operation: action,
        });
      } else if (action === "paste") {
        const source = useWorkspaceFileActionStore.getState().clipboard;
        if (!canPasteWorkspaceFile(source, { ...target, path: entry.path }) || !source) return;
        void execute(
          {
            kind: source.operation === "cut" ? "move" : "copy",
            path: source.path,
            targetDirectory: entry.path,
          },
          undefined,
          source.id,
        );
      } else {
        setDialog({
          id: ++nextDialogId.current,
          action,
          entry,
          name: action === "rename" ? entry.name : "",
          error: null,
        });
      }
    },
    [canRun, execute, target],
  );
  const submit = useCallback(() => {
    if (!dialog || !canRun(dialog.action, dialog.entry)) return;
    const { action, entry, name, id } = dialog;
    if (action !== "delete" && getWorkspaceFileNameError(name)) {
      setDialog({
        ...dialog,
        error: intl.formatMessage({ id: "workspaceFileTree.actions.invalidName" }),
      });
      return;
    }
    const mutation: WorkspaceFileMutation =
      action === "delete"
        ? { kind: "delete", path: entry.path }
        : action === "rename"
          ? { kind: "rename", path: entry.path, name }
          : { kind: action, parentPath: entry.path, name };
    void execute(mutation, id);
  }, [canRun, dialog, execute, intl]);
  const controller: WorkspaceFileActionController = {
    canRun,
    run,
    isCut: (path) =>
      clipboard?.operation === "cut" &&
      getWorkspaceFileActionKey(clipboard) === scopeKey &&
      areWorkspaceFilePathsEqual(clipboard.path, path),
    dialogOpen: dialog !== null,
  };
  return {
    controller,
    dialog,
    busy,
    submit,
    changeName: (name: string) =>
      setDialog((current) => (current ? { ...current, name, error: null } : current)),
    cancel: () => {
      if (!busy) setDialog(null);
    },
  };
}
