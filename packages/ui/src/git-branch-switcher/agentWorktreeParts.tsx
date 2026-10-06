import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GitWorktreeDialog } from "@/git-branch-switcher/GitWorktreeDialog.js";
import { GitBranchIcon } from "lucide-react";

/**
 * Agent worktree 隔离的三个独立渲染件（docs/specs/agent-worktree-isolation.md）。
 * 从 GitBranchSwitcher 拆出：菜单项、已附加 chip、受控对话框各自独立，
 * GitBranchSwitcher 只做编排，避免单文件超过 lint 的行数上限。
 */

/** 分支菜单 footer 里的「在新 worktree 中检出」入口（仅草稿 composer 实例渲染）。 */
export function AgentWorktreeMenuItem({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Button
      type="button"
      variant="ghost"
      size="lg"
      className="w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground"
      disabled={disabled}
      onClick={onClick}
    >
      <GitBranchIcon className="size-4 text-foreground-subtle" />
      {intl.formatMessage({ id: "git.branchSwitcher.worktreeAction" })}
    </Button>
  );
}

/** 触发器旁的「Agent 将在 <branch> 工作」提示 chip，草稿与正式会话共用。 */
export function AgentWorktreeChip({ branch }: { branch: string }) {
  const { intl } = useZCodeIntl();

  return (
    <span
      data-testid="agent-worktree-attached-chip"
      className="ml-1 inline-flex min-w-0 items-center gap-1 rounded-full bg-background/60 px-2 py-0.5 text-ui-base text-foreground-subtle"
    >
      <GitBranchIcon className="size-3.5 shrink-0" />
      <span className="truncate">
        {intl.formatMessage({ id: "git.worktreeNotice.attached" }, { branch })}
      </span>
    </span>
  );
}

/**
 * 受控的 worktree 创建对话框：open 由菜单项驱动，分支名输入框状态自持，
 * 关闭（取消或提交）时自动清空草稿，父组件只感知最终提交的分支名。
 */
export function AgentWorktreeDraftDialog({
  open,
  attachPending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  attachPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onConfirm: (branch: string) => void;
}) {
  const [branchName, setBranchName] = useState("");

  useEffect(() => {
    if (!open) {
      setBranchName("");
    }
  }, [open]);

  return (
    <GitWorktreeDialog
      open={open}
      branchName={branchName}
      mutationPending={attachPending}
      onOpenChange={onOpenChange}
      onBranchNameChange={setBranchName}
      onCancel={() => {
        onOpenChange(false);
      }}
      onSubmit={() => {
        const branch = branchName.trim();
        if (!branch) {
          return;
        }
        onOpenChange(false);
        onConfirm(branch);
      }}
    />
  );
}
