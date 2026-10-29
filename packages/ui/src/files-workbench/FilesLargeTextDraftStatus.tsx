import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { filesBufferTabTitle, findFilesBuffer } from "@/files-workbench/filesEditorModel.js";
import { useFilesEditorStore } from "@/files-workbench/FilesEditorStoreProvider.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import type { FilesLargeTextDraftPersistenceHandle } from "@/files-workbench/useFilesLargeTextDraftPersistence.js";
import type {
  FilesLargeTextDraftBlockedReason,
  FilesLargeTextDraftStorageErrorKind,
} from "@/files-workbench/filesLargeTextDraftStorage.js";
import { getPathLeaf } from "@/lib/path.js";

/**
 * 大文件 IndexedDB 草稿状态提示（纯展示）。
 *
 * - pending：异步去抖 / 串行写入中；
 * - blocked：记录仍在，但基准版本、文件身份或探测结果不允许套用；
 * - error：IndexedDB 读写失败。
 *
 * 组件只接收投影后的条目与显式动作，不读取 Store，也不复制 changes。
 * 「放弃草稿」是破坏性操作，必须在组件内二次确认后才能回调 `onDiscard`。
 */

export interface FilesLargeTextDraftStatusEntry {
  bufferId: string;
  /** 标签标题或草稿记录路径的末段。 */
  name: string;
  status: "pending" | "blocked" | "error";
  blockedReason?: FilesLargeTextDraftBlockedReason;
  errorKind?: FilesLargeTextDraftStorageErrorKind;
}

const BLOCKED_REASON_KEYS: Record<FilesLargeTextDraftBlockedReason, string> = {
  "version-mismatch": "filesWorkbench.largeTextDraft.blocked.versionMismatch",
  missing: "filesWorkbench.largeTextDraft.blocked.missing",
  binary: "filesWorkbench.largeTextDraft.blocked.binary",
  "identity-mismatch": "filesWorkbench.largeTextDraft.blocked.identityMismatch",
  "probe-failed": "filesWorkbench.largeTextDraft.blocked.probeFailed",
  "rename-target-retained": "filesWorkbench.largeTextDraft.blocked.renameTargetRetained",
};

const ERROR_KEYS: Record<FilesLargeTextDraftStorageErrorKind, string> = {
  unavailable: "filesWorkbench.largeTextDraft.error.unavailable",
  quota: "filesWorkbench.largeTextDraft.error.quota",
  failed: "filesWorkbench.largeTextDraft.error.failed",
};

/**
 * 把持久化快照投影成展示条目，并提供显式重试 / 放弃动作。
 * Surface 只负责把 controller 的句柄传进来，不复制草稿内容。
 */
export function useFilesLargeTextDraftStatus({
  buffers,
  openIds,
  drafts,
}: {
  buffers: FilesBuffer[];
  openIds: string[];
  drafts: FilesLargeTextDraftPersistenceHandle;
}) {
  const snapshot = drafts.snapshot;
  const entries = useMemo<FilesLargeTextDraftStatusEntry[]>(() => {
    const nameFor = (bufferId: string, fallbackPath: string) => {
      const buffer = findFilesBuffer({ buffers, openIds, untitledSerial: 1 }, bufferId);
      return buffer ? filesBufferTabTitle(buffer) : getPathLeaf(fallbackPath);
    };
    const result: FilesLargeTextDraftStatusEntry[] = [];
    for (const [bufferId, blocked] of Object.entries(snapshot.blocked)) {
      result.push({
        bufferId,
        name: nameFor(bufferId, blocked.record.path),
        status: "blocked",
        blockedReason: blocked.reason,
      });
    }
    for (const [bufferId, error] of Object.entries(snapshot.errors)) {
      if (snapshot.blocked[bufferId]) continue;
      result.push({
        bufferId,
        name: nameFor(bufferId, ""),
        status: "error",
        errorKind: error.kind,
      });
    }
    for (const [bufferId, pending] of Object.entries(snapshot.pending)) {
      if (!pending || snapshot.blocked[bufferId] || snapshot.errors[bufferId]) continue;
      result.push({ bufferId, name: nameFor(bufferId, ""), status: "pending" });
    }
    return result;
  }, [buffers, openIds, snapshot]);

  const retry = useCallback(
    (bufferId: string) => {
      // 重新探测 / 读取同一草稿；失败仍保留记录并继续显示 blocked / error。
      void drafts
        .restoreOnActivate(bufferId)
        .then(() => drafts.flush())
        .catch(() => drafts.flush());
    },
    [drafts],
  );
  // 只有在组件内的二次确认通过后才会走到这里，绝不静默删除 blocked 草稿。
  const discard = useCallback(
    (bufferId: string) => {
      void drafts.discardBlockedDraft(bufferId);
    },
    [drafts],
  );

  return { entries, retry, discard };
}

export function FilesLargeTextDraftStatusView({
  entries,
  onRetry,
  onDiscard,
}: {
  entries: readonly FilesLargeTextDraftStatusEntry[];
  onRetry: (bufferId: string) => void;
  onDiscard: (bufferId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 仅保存待确认的 bufferId；草稿内容仍只来自上层的 Store 投影。
  const [confirmingDiscard, setConfirmingDiscard] = useState<FilesLargeTextDraftStatusEntry | null>(
    null,
  );

  const confirmDiscard = useCallback(() => {
    if (!confirmingDiscard) return;
    onDiscard(confirmingDiscard.bufferId);
    setConfirmingDiscard(null);
  }, [confirmingDiscard, onDiscard]);

  if (entries.length === 0) return null;

  return (
    <>
      <div className="flex shrink-0 flex-col" data-files-large-text-draft-status="">
        {entries.map((entry) => {
          if (entry.status === "pending") {
            return (
              <div
                key={`pending:${entry.bufferId}`}
                role="status"
                data-files-large-text-draft-pending=""
                className="flex items-center gap-2 border-b border-border/60 bg-surface px-3 py-1 text-ui-sm text-foreground-subtle"
              >
                <span className="min-w-0 flex-1 truncate">
                  {intl.formatMessage(
                    { id: "filesWorkbench.largeTextDraft.pending" },
                    { name: entry.name || entry.bufferId },
                  )}
                </span>
              </div>
            );
          }
          const blocked = entry.status === "blocked";
          const message = blocked
            ? intl.formatMessage(
                {
                  id: BLOCKED_REASON_KEYS[entry.blockedReason ?? "version-mismatch"],
                },
                { name: entry.name || entry.bufferId },
              )
            : intl.formatMessage(
                { id: ERROR_KEYS[entry.errorKind ?? "failed"] },
                { name: entry.name || entry.bufferId },
              );
          return (
            <div
              key={`${entry.status}:${entry.bufferId}`}
              role="alert"
              data-files-large-text-draft-blocked={blocked ? "" : undefined}
              data-files-large-text-draft-error={blocked ? undefined : ""}
              className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1 text-ui-sm text-foreground"
            >
              <span className="min-w-0 flex-1">{message}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onRetry(entry.bufferId)}
              >
                {intl.formatMessage({ id: "filesWorkbench.largeTextDraft.retry" })}
              </Button>
              {blocked ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setConfirmingDiscard(entry)}
                >
                  {intl.formatMessage({ id: "filesWorkbench.largeTextDraft.discard" })}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      <Dialog
        open={confirmingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingDiscard(null);
        }}
      >
        <DialogContent data-files-large-text-draft-discard-dialog="">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "filesWorkbench.largeTextDraft.discardTitle" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage(
                { id: "filesWorkbench.largeTextDraft.discardDescription" },
                { name: confirmingDiscard?.name ?? "" },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmingDiscard(null)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDiscard}>
              {intl.formatMessage({ id: "filesWorkbench.largeTextDraft.discardConfirm" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 文件工作台内使用的自包含版本：只接持久化句柄，名称从 Store 投影。 */
export function FilesLargeTextDraftStatus({
  drafts,
}: {
  drafts: FilesLargeTextDraftPersistenceHandle;
}) {
  const buffers = useFilesEditorStore((state) => state.buffers);
  const openIds = useFilesEditorStore((state) => state.openIds);
  const { entries, retry, discard } = useFilesLargeTextDraftStatus({ buffers, openIds, drafts });
  return <FilesLargeTextDraftStatusView entries={entries} onRetry={retry} onDiscard={discard} />;
}
