import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry } from "@zcode/shared";
import type { IFileService } from "@zcode/services";
import { ArrowLeft, Folder } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { filesParentDirectory, filesSaveAsTargetPath } from "@/files-workbench/filesSaveAsPath.js";
import { useFilesSaveAsNativeDialog } from "@/files-workbench/useFilesSaveAsNativeDialog.js";
import { logger } from "@/logger.js";

export function FilesSaveAsNativeAction({
  available,
  pending,
  failed,
  onOpen,
}: {
  available: boolean;
  pending: boolean;
  failed: boolean;
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (!available) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 sm:mr-auto">
      <Button type="button" variant="outline" disabled={pending} onClick={onOpen}>
        {intl.formatMessage({ id: "filesWorkbench.useSystemDialog" })}
      </Button>
      {failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "filesWorkbench.useSystemDialogFailed" })}
        </p>
      ) : null}
    </div>
  );
}

export function FilesSaveAsDialog({
  open,
  bufferId,
  workspaceKey,
  defaultDirectory,
  defaultFileName,
  fileService,
  allowNativePath = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** 当前另存为目标；目标变化时旧的原生请求结果作废。 */
  bufferId?: string;
  workspaceKey?: string;
  defaultDirectory?: string;
  defaultFileName?: string;
  fileService?: IFileService;
  /** 只有 Desktop 本机目标为 true；远程、Web 和手机保持内置浏览器。 */
  allowNativePath?: boolean;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [directory, setDirectory] = useState(defaultDirectory ?? "");
  const [fileName, setFileName] = useState(defaultFileName ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // 目录读取和原生请求一样有代次：关闭、换目标或换文件服务后，旧 readdir 结果不得覆盖当前弹窗。
  const directoryRequestRef = useRef(0);

  const loadDirectory = useCallback(
    async (nextDirectory: string) => {
      const requestId = ++directoryRequestRef.current;
      if (!fileService || !nextDirectory) {
        setEntries([]);
        return;
      }
      try {
        const nextEntries = await fileService.readdir({ path: nextDirectory });
        if (requestId !== directoryRequestRef.current) {
          return;
        }
        setEntries(nextEntries.filter((entry) => entry.type === "directory"));
        setDirectory(nextDirectory);
      } catch (error) {
        if (requestId !== directoryRequestRef.current) {
          return;
        }
        logger.warn("[files-workbench] 另存为目录读取失败", { directory: nextDirectory, error });
      }
    },
    [fileService],
  );

  useEffect(() => {
    directoryRequestRef.current += 1;
    if (!open) {
      return;
    }
    // 重新打开或更换目标时先回到目标默认目录，目录读取失败时也不残留上一次的列表。
    setFileName(defaultFileName ?? "");
    setDirectory(defaultDirectory ?? "");
    setEntries([]);
    void loadDirectory(defaultDirectory ?? "");
    // 卸载或依赖变化后使在途 readdir 失效，迟到结果不得再写状态。
    return () => {
      directoryRequestRef.current += 1;
    };
  }, [bufferId, defaultDirectory, defaultFileName, loadDirectory, open, workspaceKey]);

  const parentDirectory = filesParentDirectory(directory);
  const targetPath = filesSaveAsTargetPath(directory, fileName);
  const nativeSaveDialog = useFilesSaveAsNativeDialog({
    open,
    bufferId,
    workspaceKey,
    fileService,
    allowNativePath,
    platform,
    directory,
    fileName,
    title: intl.formatMessage({ id: "filesWorkbench.saveAs" }),
    onConfirm,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "filesWorkbench.saveAs" })}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!parentDirectory || nativeSaveDialog.pending}
              onClick={() => {
                if (parentDirectory) {
                  void loadDirectory(parentDirectory);
                }
              }}
              aria-label={intl.formatMessage({ id: "filesWorkbench.saveDirectory" })}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <p className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">{directory}</p>
          </div>
          <div className="max-h-56 overflow-auto rounded-lg border border-border">
            {entries.length === 0 ? (
              <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "filesWorkbench.emptyExplorer" })}
              </p>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-sm hover:bg-surface-hover"
                  disabled={nativeSaveDialog.pending}
                  onClick={() => void loadDirectory(entry.path)}
                >
                  <Folder className="size-3.5 shrink-0 text-foreground-subtle" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            )}
          </div>
          <label className="flex flex-col gap-1 text-ui-sm">
            {intl.formatMessage({ id: "filesWorkbench.fileName" })}
            <Input
              value={fileName}
              disabled={nativeSaveDialog.pending}
              onChange={(event) => setFileName(event.currentTarget.value)}
            />
          </label>
        </div>
        <DialogFooter>
          <FilesSaveAsNativeAction
            available={nativeSaveDialog.available}
            pending={nativeSaveDialog.pending}
            failed={nativeSaveDialog.failed}
            onOpen={nativeSaveDialog.openDialog}
          />
          <Button type="button" variant="ghost" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            disabled={!targetPath || nativeSaveDialog.pending}
            onClick={() => {
              if (targetPath) {
                onConfirm(targetPath);
              }
            }}
          >
            {intl.formatMessage({ id: "filesWorkbench.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
