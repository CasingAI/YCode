import { TID_V4_TASK_OPEN_IN_SPLIT } from "@zcode/shared";

interface TaskActionMenuItemProps {
  children: React.ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

interface TaskActionMenuSeparatorProps {
  key?: string;
}

interface TaskActionMenuSubProps {
  children?: React.ReactNode;
}

interface TaskActionMenuSubTriggerProps {
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}

interface TaskActionMenuSubContentProps {
  children?: React.ReactNode;
  className?: string;
}

export function TaskActionMenuContent({
  intl,
  isPinned,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  disableTaskActions = false,
  disableTaskTargetActions = false,
  disablePinTaskAction = false,
  disabledReason,
  hideMobileUnsupportedActions = false,
  Item,
  Separator,
  Sub,
  SubTrigger,
  SubContent,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenInSplitPane,
  openInSplitPaneDisabled = false,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  disableTaskActions?: boolean;
  disableTaskTargetActions?: boolean;
  disablePinTaskAction?: boolean;
  disabledReason?: string;
  hideMobileUnsupportedActions?: boolean;
  Item: React.ComponentType<TaskActionMenuItemProps>;
  Separator: React.ComponentType<TaskActionMenuSeparatorProps>;
  Sub: React.ComponentType<TaskActionMenuSubProps>;
  SubTrigger: React.ComponentType<TaskActionMenuSubTriggerProps>;
  SubContent: React.ComponentType<TaskActionMenuSubContentProps>;
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  /** 「在分屏打开」（仅桌面 shell 传入；手机远控不显示该入口）。 */
  onOpenInSplitPane?: () => void;
  /** 当前 session 或 pane 数达上限且目标无已有归属时禁用（保留布局与层级）。 */
  openInSplitPaneDisabled?: boolean;
  onOpenTaskFeedback?: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
}) {
  const taskTargetActionsDisabled = disableTaskActions || disableTaskTargetActions;

  return (
    <>
      <Item
        disabled={taskTargetActionsDisabled || disablePinTaskAction}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={() => {
          if (!taskTargetActionsDisabled && !disablePinTaskAction) {
            onTogglePinTask();
          }
        }}
      >
        {intl.formatMessage({ id: isPinned ? "taskList.unpin" : "taskList.pin" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onStartRenameTask();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.rename" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onArchiveTask();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.archive" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onMarkTaskAsUnread();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.markAsUnread" })}
      </Item>
      {onOpenInSplitPane ? (
        <Item
          data-testid={TID_V4_TASK_OPEN_IN_SPLIT}
          disabled={taskTargetActionsDisabled || openInSplitPaneDisabled}
          onSelect={onOpenInSplitPane}
        >
          {intl.formatMessage({ id: "taskList.openInSplitPane" })}
        </Item>
      ) : null}
      <Separator />
      {!hideMobileUnsupportedActions ? (
        <>
          <Item
            disabled={disableTaskActions}
            title={disableTaskActions ? disabledReason : undefined}
            onSelect={() => {
              if (!disableTaskActions) {
                onOpenTaskPathInFileManager();
              }
            }}
          >
            {fileManagerLabel}
          </Item>
          {/* 这条分隔线和上面的「在 Finder 中打开」同生共死：窄视口隐藏该条目时
              它必须一起消失，否则它和上面那条任务管理分组边界线相邻，
              一级菜单就会在「标记为未读」与「复制信息」之间画出两根横线。 */}
          <Separator />
        </>
      ) : null}
      {/* 四项复制动作都是低频诊断动作，和任务管理动作不在同一层级，
          收进「复制信息」二级菜单后一级菜单只剩主流程入口。成员关系加载中时
          「复制路径」仍可用，所以触发器不能跟着 disableTaskTargetActions 走，
          只在只读态（四项全禁用）时才禁用。 */}
      <Sub>
        <SubTrigger
          disabled={disableTaskActions}
          title={disableTaskActions ? disabledReason : undefined}
        >
          {intl.formatMessage({ id: "taskList.copyInfo" })}
        </SubTrigger>
        <SubContent className="w-52">
          <Item
            disabled={disableTaskActions}
            title={disableTaskActions ? disabledReason : undefined}
            onSelect={onCopyWorkspacePath}
          >
            {intl.formatMessage({ id: "appHeader.copyPath" })}
          </Item>
          <Item
            disabled={taskTargetActionsDisabled || taskSessionFile.loading || !taskSessionFile.path}
            title={taskTargetActionsDisabled ? disabledReason : undefined}
            onSelect={onCopyTaskPath}
          >
            {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
          </Item>
          <Item
            disabled={
              taskTargetActionsDisabled ||
              taskNativeSessionLogFile.loading ||
              !taskNativeSessionLogFile.path
            }
            title={taskTargetActionsDisabled ? disabledReason : undefined}
            onSelect={onCopyTaskLogPath}
          >
            {/* ZCode Agent 的日志路径可能先按运行时约定得出，当前日期文件尚未落盘。
                复制动作只依赖路径字符串，不能把 exists=false 当成不可复制，否则菜单会表现成“不能点”。 */}
            {intl.formatMessage({ id: "appHeader.copyLogPath" })}
          </Item>
          {onCopySessionId ? (
            <Item
              disabled={taskTargetActionsDisabled || !activeSessionId}
              title={taskTargetActionsDisabled ? disabledReason : undefined}
              onSelect={onCopySessionId}
            >
              {intl.formatMessage({ id: "appHeader.copySessionId" })}
            </Item>
          ) : null}
        </SubContent>
      </Sub>
      {/* 「查看调用轨迹」和「反馈问题」都是排障入口，不属于任务管理动作，
          收进「调试」子菜单后一级菜单只留主流程分组。两项各自有独立禁用条件
          （轨迹还要求 activeSessionId），触发器若跟着它们走，子项的禁用理由
          就没有入口可查，所以只在只读态禁用。 */}
      {onViewModelTrajectory || onOpenTaskFeedback ? (
        <>
          <Separator />
          <Sub>
            <SubTrigger
              disabled={disableTaskActions}
              title={disableTaskActions ? disabledReason : undefined}
            >
              {intl.formatMessage({ id: "taskList.debug" })}
            </SubTrigger>
            <SubContent className="w-52">
              {onViewModelTrajectory ? (
                <Item
                  disabled={taskTargetActionsDisabled || !activeSessionId}
                  title={taskTargetActionsDisabled ? disabledReason : undefined}
                  onSelect={onViewModelTrajectory}
                >
                  {/* 调用轨迹查看：从 ~/.zcode/cli 的 model-io 还原该 task 的模型请求/响应/工具调用，
                      在右侧边栏可视化。只依赖 taskId（即 sessionId），不依赖快照文件是否落盘。 */}
                  {intl.formatMessage({ id: "taskList.viewModelTrajectory" })}
                </Item>
              ) : null}
              {onOpenTaskFeedback ? (
                <Item disabled={taskTargetActionsDisabled} onSelect={onOpenTaskFeedback}>
                  {intl.formatMessage({ id: "taskList.feedback" })}
                </Item>
              ) : null}
            </SubContent>
          </Sub>
        </>
      ) : null}
    </>
  );
}
