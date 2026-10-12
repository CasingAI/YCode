export function runWorkspaceVisibleCommand({
  isWorkspaceVisible,
  onReturnToWorkspace,
  run,
}: {
  isWorkspaceVisible: boolean;
  onReturnToWorkspace?: () => void;
  run: () => void;
}) {
  if (!isWorkspaceVisible) {
    // 设置是外壳主视图，会话树仍挂着。快捷键若直接改任务/终端，用户还停在设置正文里，看起来像没生效。
    // 先切回任务主视图再执行，让结果出现在眼前。
    onReturnToWorkspace?.();
  }

  run();
}
