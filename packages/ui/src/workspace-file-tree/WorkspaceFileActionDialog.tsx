import { useId } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getWorkspaceFileNameError } from "@/workspace-file-tree/fileActionRules.js";
import type { WorkspaceFileActionDialogState } from "@/workspace-file-tree/fileActionTypes.js";

export function WorkspaceFileActionDialog({
  state,
  busy,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  state: WorkspaceFileActionDialogState | null;
  busy: boolean;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const nameId = useId();
  const deleting = state?.action === "delete";
  const invalidName = !deleting && state?.name && getWorkspaceFileNameError(state.name);
  const error =
    state?.error ??
    (invalidName ? intl.formatMessage({ id: "workspaceFileTree.actions.invalidName" }) : null);
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({
                id: `workspaceFileTree.actions.${state?.action ?? "create-file"}`,
              })}
            </DialogTitle>
            <DialogDescription className="break-all">
              {deleting
                ? intl.formatMessage(
                    { id: "workspaceFileTree.actions.deleteDescription" },
                    { name: state?.entry.name },
                  )
                : state?.entry.path}
            </DialogDescription>
          </DialogHeader>
          {!deleting ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={nameId} className="text-ui-sm">
                {intl.formatMessage({ id: "workspaceFileTree.actions.name" })}
              </label>
              <Input
                id={nameId}
                autoComplete="off"
                value={state?.name ?? ""}
                disabled={busy}
                aria-invalid={Boolean(error)}
                onChange={(event) => onNameChange(event.currentTarget.value)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="submit"
              variant={deleting ? "destructive" : "default"}
              disabled={
                busy || (!deleting && Boolean(getWorkspaceFileNameError(state?.name ?? "")))
              }
            >
              {intl.formatMessage({
                id: busy
                  ? "workspaceFileTree.actions.working"
                  : deleting
                    ? "workspaceFileTree.actions.deletePermanently"
                    : "common.confirm",
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
