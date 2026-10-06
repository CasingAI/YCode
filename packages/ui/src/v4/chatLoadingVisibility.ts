import type {
  ActiveWorkSummary,
  ConversationRow,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 等待用户操作时，弹窗/问答卡已经是唯一进度反馈，不能再显示 loading。
 * 这里只识别权限确认与 AskUserQuestion；ExitPlanMode 等其它 userInput 语义保持独立。
 * 软门禁后 workspaceHookReview 不再阻塞聊天。
 */
export function hasChatLoadingBlockingInteraction(
  interactions: readonly PendingInteraction[],
): boolean {
  return interactions.some(
    (interaction) =>
      interaction.payload.kind === "permission" ||
      (interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === "AskUserQuestion"),
  );
}

export function hasChatLoadingBlockingActiveWork(
  activeWorks: readonly ActiveWorkSummary[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact" || work.kind === "goalVerifier");
}

function hasChatLoadingBlockingMaintenanceRow(rows: readonly ConversationRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")),
  );
}

/**
 * 轮内转圈槽的可见性。
 *
 * 两层判据，不能合并（合并过两次，各错一次）：
 * - 放置约束 `isLastTurn`：转圈槽是逐轮渲染的，只有窗口末轮允许亮——否则连尾时
 *   每一轮都亮一个，「会话在跑」退化成「每轮都在跑」（回归缺陷：双转圈）。
 * - 显隐判据 `sessionRunning`：运行态只认会话控制面（`snapshot.session.control.phase`），
 *   不看「窗口末轮是哪一轮」——用户跳到会话中部读历史时，转圈仍然如实回答
 *   「会话还在跑吗」。早前按「末轮且它自己在跑」判，跳转一次就熄灭一次。
 *
 * `rows` 是这一轮的过程行，只用于行级 fallback（见下方注释），不参与运行态判定。
 */
export function shouldShowTurnChatLoading({
  isLastTurn,
  blockedByActiveWork,
  blockedByInteraction,
  sessionRunning,
  rows,
}: {
  isLastTurn: boolean;
  blockedByActiveWork: boolean;
  blockedByInteraction: boolean;
  sessionRunning: boolean;
  rows: readonly ConversationRow[];
}): boolean {
  if (!isLastTurn || !sessionRunning || blockedByActiveWork || blockedByInteraction) {
    return false;
  }

  // pendingInteractions / activeWorks 是权威事实源，但恢复或乱序窗口
  // 可能先只有行状态；行级 fallback 避免权限、compact、goal verifier 已出现时
  // 底部 loading 短暂闪回。
  return (
    !rows.some((row) => row.kind === "toolCall" && row.status === "pendingApproval") &&
    !hasChatLoadingBlockingMaintenanceRow(rows)
  );
}
