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
import type { FilesDirtyCloseDecision, FilesSaveConflictDecision } from "@/files-workbench/filesEditorTypes.js";

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
  onDecide,
}: {
  open: boolean;
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
          <DialogTitle>{intl.formatMessage({ id: "filesWorkbench.conflictTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "filesWorkbench.conflictDescription" })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onDecide("cancel")}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button type="button" variant="outline" onClick={() => onDecide("reload")}>
            {intl.formatMessage({ id: "filesWorkbench.conflictReload" })}
          </Button>
          <Button type="button" onClick={() => onDecide("overwrite")}>
            {intl.formatMessage({ id: "filesWorkbench.conflictOverwrite" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
