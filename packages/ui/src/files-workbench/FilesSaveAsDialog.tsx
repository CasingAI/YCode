import { useCallback, useEffect, useState } from "react";
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { filesParentDirectory, filesSaveAsTargetPath } from "@/files-workbench/filesSaveAsPath.js";
import { logger } from "@/logger.js";

export function FilesSaveAsDialog({
  open,
  defaultDirectory,
  defaultFileName,
  fileService,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  defaultDirectory?: string;
  defaultFileName?: string;
  fileService?: IFileService;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [directory, setDirectory] = useState(defaultDirectory ?? "");
  const [fileName, setFileName] = useState(defaultFileName ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);

  const loadDirectory = useCallback(
    async (nextDirectory: string) => {
      if (!fileService || !nextDirectory) {
        setEntries([]);
        return;
      }
      try {
        const nextEntries = await fileService.readdir({ path: nextDirectory });
        setEntries(nextEntries.filter((entry) => entry.type === "directory"));
        setDirectory(nextDirectory);
      } catch (error) {
        logger.warn("[files-workbench] 另存为目录读取失败", { directory: nextDirectory, error });
      }
    },
    [fileService],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setFileName(defaultFileName ?? "");
    void loadDirectory(defaultDirectory ?? "");
  }, [defaultDirectory, defaultFileName, loadDirectory, open]);

  const parentDirectory = filesParentDirectory(directory);
  const targetPath = filesSaveAsTargetPath(directory, fileName);

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
              disabled={!parentDirectory}
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
            <Input value={fileName} onChange={(event) => setFileName(event.currentTarget.value)} />
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            disabled={!targetPath}
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
