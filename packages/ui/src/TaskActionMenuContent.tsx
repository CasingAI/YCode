import { TID_V4_TASK_OPEN_IN_SPLIT } from "@zcode/shared";
import { Check } from "lucide-react";
import { TaskGroupColorDot } from "@/workspace-grouped-tasks/colors.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/types.js";

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
  isArchived = false,
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
  onRegenerateTaskTitle,
  onArchiveTask,
  onUnarchiveTask,
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
  groupMenu,
}: {
  intl: {
    formatMessage: (
      desc: { id: string },
      values?: Record<string, string>,
    ) => string;
  };
  isPinned: boolean;
  /**
   * 当前任务是否已归档。归档行按它在「归档任务」与「取消归档任务」之间切换文案与回调，
   * 行的位置与层级不变。取值来源见 docs/specs/task-archive-membership-in-header-menu.md。
   */
  isArchived?: boolean;
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
  /**
   * 扁平任务菜单的「移动到分组」子菜单数据。缺省即不渲染该 Sub：
   * 远端任务、pinned/archived 任务、无分组视图上下文的调用方都不传。
   * 行为见 docs/specs/task-flat-menu-move-to-group.md。
   */
  groupMenu?: {
    groups: TaskGroupMenuItem[];
    currentGroupId: string | null;
    onMoveToGroup: (groupId: string | null) => void;
    onCreateGroupAndMove: () => void;
  };
  Item: React.ComponentType<TaskActionMenuItemProps>;
  Separator: React.ComponentType<TaskActionMenuSeparatorProps>;
  Sub: React.ComponentType<TaskActionMenuSubProps>;
  SubTrigger: React.ComponentType<TaskActionMenuSubTriggerProps>;
  SubContent: React.ComponentType<TaskActionMenuSubContentProps>;
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  /** 「重新生成标题」（未传入则整项不渲染）。行为见 docs/specs/session-title-regeneration.md。 */
  onRegenerateTaskTitle?: () => void;
  onArchiveTask: () => void;
  /** 「取消归档任务」的执行体；只在 isArchived 为真时被调用。 */
  onUnarchiveTask?: () => void;
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
  const taskTargetActionsDisabled =
    disableTaskActions || disableTaskTargetActions;

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
        {intl.formatMessage({
          id: isPinned ? "taskList.unpin" : "taskList.pin",
        })}
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
          if (taskTargetActionsDisabled) {
            return;
          }
          // 已归档时这一行是「取消归档」而不是「归档」：对归档任务再调 archiveTask 只会
          // 把 archived 重写成同一个值，用户看到的是「白弹一次确认框，什么也没变」。
          if (isArchived) {
            onUnarchiveTask?.();
            return;
          }
          onArchiveTask();
        }}
      >
        {intl.formatMessage({
          id: isArchived ? "taskList.unarchive" : "taskList.archive",
        })}
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
      {/* 「移动到分组」坐在任务管理分组内部，不占独立分隔线分组：
          groupMenu 缺省时这一整块不渲染，分隔线数量与
          docs/specs/task-action-menu-submenus.md 定义的 3 条（窄屏 2 条）完全一致。
          勾选式归属：当前组行 leading 打勾、可点（点击即移出），不再用 disabled 表达
          「你已在这里」；「移出分组」文案只作当前组行的 trailing 提示与 title，不再是独立菜单项。
          组列表按 grouped 视图节点顺序透传，不在这里重排。 */}
      {groupMenu ? (
        <Sub>
          <SubTrigger
            disabled={disableTaskActions}
            title={disableTaskActions ? disabledReason : undefined}
          >
            {intl.formatMessage({ id: "taskGroup.moveToGroup" })}
          </SubTrigger>
          <SubContent className="w-52">
            {groupMenu.groups.map((group) => {
              // 当前组即选中态：保持可点，点击语义是移出该组（onMoveToGroup(null)），
              // 非当前组点击语义是移入。只读态才禁用，不再用置灰表达归属。
              const isCurrentGroup = group.id === groupMenu.currentGroupId;
              const removeFromGroupLabel = intl.formatMessage({
                id: "taskGroup.removeFromGroup",
              });
              return (
                <Item
                  key={group.id}
                  disabled={taskTargetActionsDisabled}
                  title={
                    taskTargetActionsDisabled
                      ? disabledReason
                      : isCurrentGroup
                        ? removeFromGroupLabel
                        : undefined
                  }
                  onSelect={() => {
                    if (taskTargetActionsDisabled) {
                      return;
                    }
                    if (isCurrentGroup) {
                      groupMenu?.onMoveToGroup(null);
                      return;
                    }
                    groupMenu?.onMoveToGroup(group.id);
                  }}
                >
                  {isCurrentGroup ? (
                    <Check className="size-4 shrink-0 text-foreground-subtle" />
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  <TaskGroupColorDot color={group.color} />
                  <span className="truncate">{group.title}</span>
                  {isCurrentGroup ? (
                    <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtlest">
                      {removeFromGroupLabel}
                    </span>
                  ) : null}
                </Item>
              );
            })}
            {groupMenu.groups.length > 0 ? <Separator /> : null}
            <Item
              disabled={taskTargetActionsDisabled}
              title={taskTargetActionsDisabled ? disabledReason : undefined}
              onSelect={() => {
                if (!taskTargetActionsDisabled) {
                  groupMenu.onCreateGroupAndMove();
                }
              }}
            >
              {intl.formatMessage({ id: "taskGroup.newGroupAndMove" })}
            </Item>
          </SubContent>
        </Sub>
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
            disabled={
              taskTargetActionsDisabled ||
              taskSessionFile.loading ||
              !taskSessionFile.path
            }
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
      {/* 「重新生成标题」「查看调用轨迹」「反馈问题」都不是任务管理动作：
          前者是对已生成结果的修复入口，后两者是排障入口，收进「调试」子菜单后
          一级菜单只留主流程分组。三项各自有独立禁用条件，触发器若跟着它们走，
          子项的禁用理由就没有入口可查，所以只在只读态禁用。 */}
      {onRegenerateTaskTitle || onViewModelTrajectory || onOpenTaskFeedback ? (
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
              {onRegenerateTaskTitle ? (
                <Item
                  disabled={taskTargetActionsDisabled}
                  title={taskTargetActionsDisabled ? disabledReason : undefined}
                  onSelect={onRegenerateTaskTitle}
                >
                  {intl.formatMessage({ id: "taskList.regenerateTitle" })}
                </Item>
              ) : null}
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
                <Item
                  disabled={taskTargetActionsDisabled}
                  onSelect={onOpenTaskFeedback}
                >
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
