import { type FormEvent } from "react";
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
import { LoaderIcon } from "lucide-react";

interface GitWorktreeDialogProps {
  open: boolean;
  branchName: string;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onBranchNameChange: (nextValue: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

/**
 * Agent worktree 隔离对话框（docs/specs/agent-worktree-isolation.md）。
 * 形态与「创建并检出新分支」一致，但提交语义独立（发 attach 意图，不走
 * createBranchAndSwitch 的用户工作区切换）；文案强调不切换当前分支。
 */
export function GitWorktreeDialog({
  open,
  branchName,
  mutationPending,
  onOpenChange,
  onBranchNameChange,
  onCancel,
  onSubmit,
}: GitWorktreeDialogProps) {
  const { intl } = useZCodeIntl();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "git.worktreeDialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "git.worktreeDialog.description" })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5 px-6 py-6"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor="git-branch-switcher-worktree-input"
              className="inline-flex text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: "git.worktreeDialog.nameLabel" })}
            </label>
            <Input
              id="git-branch-switcher-worktree-input"
              size="lg"
              autoFocus
              value={branchName}
              disabled={mutationPending}
              placeholder={intl.formatMessage({ id: "git.worktreeDialog.placeholder" })}
              className="h-10 rounded-lg bg-background/50"
              onChange={(event) => {
                onBranchNameChange(event.target.value);
              }}
            />
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "git.worktreeDialog.helper" })}
            </p>
          </div>

          <DialogFooter className="gap-2 pt-4">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={onCancel}
              disabled={mutationPending}
              className="h-10 min-w-0 px-5"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={mutationPending || branchName.trim().length === 0}
              className="h-10 min-w-0 px-5"
            >
              {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
              {intl.formatMessage({ id: "git.worktreeDialog.confirm" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
