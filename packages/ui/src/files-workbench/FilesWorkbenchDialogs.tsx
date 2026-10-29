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
import type {
  FilesDirtyCloseDecision,
  FilesSaveConflictDecision,
} from "@/files-workbench/filesEditorTypes.js";

export function FilesDirtyCloseDialog({
  open,
  name,
  onDecide,
}: {
  open: boolean;
  name: string;
  onDecide: (decision: FilesDirtyCloseDecision) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDecide("cancel");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "filesWorkbench.dirtyCloseTitle" }, { name })}
          </DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onDecide("cancel")}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button type="button" variant="outline" onClick={() => onDecide("discard")}>
            {intl.formatMessage({ id: "filesWorkbench.dirtyCloseDiscard" })}
          </Button>
          <Button type="button" onClick={() => onDecide("save")}>
            {intl.formatMessage({ id: "filesWorkbench.dirtyCloseSave" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FilesConflictDialog({
  open,
  deleted = false,
  onDecide,
}: {
  open: boolean;
  deleted?: boolean;
  onDecide: (decision: FilesSaveConflictDecision | "cancel") => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDecide("cancel");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: deleted ? "filesWorkbench.conflictDeletedTitle" : "filesWorkbench.conflictTitle",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({
              id: deleted
                ? "filesWorkbench.conflictDeletedDescription"
                : "filesWorkbench.conflictDescription",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onDecide("cancel")}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          {/* 删除后的普通文本没有可重载的磁盘内容：只允许取消保留草稿，
              或明确「重新创建」并清空 expectedVersion 写入完整正文。 */}
          {!deleted && (
            <Button type="button" variant="outline" onClick={() => onDecide("reload")}>
              {intl.formatMessage({ id: "filesWorkbench.conflictReload" })}
            </Button>
          )}
          <Button type="button" onClick={() => onDecide("overwrite")}>
            {intl.formatMessage({
              id: deleted ? "filesWorkbench.conflictRecreate" : "filesWorkbench.conflictOverwrite",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 大文件补丁冲突：补丁坐标基于旧版本，不能强套到新版本。
 * 只能取消保留草稿，或明确丢弃草稿并重新加载。
 */
export function FilesLargeTextConflictDialog({
  open,
  onDecide,
}: {
  open: boolean;
  onDecide: (decision: "cancel" | "reload") => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDecide("cancel");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "filesWorkbench.conflictTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "filesWorkbench.largeTextConflictDescription" })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onDecide("cancel")}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button type="button" variant="outline" onClick={() => onDecide("reload")}>
            {intl.formatMessage({ id: "filesWorkbench.conflictReloadDiscard" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 外部修改后重新加载脏草稿前的确认；`keep` 保留当前草稿并清除提示。 */
export function FilesExternalChangeReloadDialog({
  open,
  name,
  onDecide,
}: {
  open: boolean;
  name: string;
  onDecide: (decision: "cancel" | "reload" | "keep") => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDecide("cancel");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "filesWorkbench.externalReloadTitle" }, { name })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "filesWorkbench.externalReloadDescription" })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onDecide("cancel")}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button type="button" variant="outline" onClick={() => onDecide("keep")}>
            {intl.formatMessage({ id: "filesWorkbench.externalChange.keep" })}
          </Button>
          <Button type="button" onClick={() => onDecide("reload")}>
            {intl.formatMessage({ id: "filesWorkbench.externalChange.reload" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
