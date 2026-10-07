import type { TaskNotificationPayload } from "@zcode/shared";
import type {
  ConversationSnapshot,
  PendingInteraction,
  SessionPhase,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/index.js";

type FormatMessage = IntlInstance["formatMessage"];

function terminalStatusForPhase(
  phase: SessionPhase,
): Extract<TaskNotificationPayload["status"], "completed" | "failed"> | null {
  if (phase === "completedSuccess" || phase === "completedInterrupted") {
    return "completed";
  }
  if (phase === "error") {
    return "failed";
  }
  return null;
}

function taskTitleBody(
  title: string,
  fallbackMessageId: string,
  formatMessage: FormatMessage,
): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    return formatMessage({ id: "notification.taskWithTitle" }, { title: trimmedTitle });
  }
  return formatMessage({ id: fallbackMessageId });
}

function terminalPayloadForSession(
  session: SessionSummary,
  status: Extract<TaskNotificationPayload["status"], "completed" | "failed">,
  formatMessage: FormatMessage,
): TaskNotificationPayload {
  if (status === "completed") {
    return {
      taskId: session.sessionId,
      status,
      title: formatMessage({ id: "notification.completed" }),
      body: taskTitleBody(session.title, "notification.completedBody", formatMessage),
    };
  }

  return {
    taskId: session.sessionId,
    status,
    title: formatMessage({ id: "notification.error" }),
    body: taskTitleBody(session.title, "notification.error", formatMessage),
  };
}

// goal 自主循环的一轮迭代里，摘要会两次短暂落进 completedSuccess：迭代 turn 收口
// （goalStatus=active）与 verifier 判定"目标未完成"的校验轮收口（goalStatus=notSatisfied），
// 随后下一轮迭代把 phase 拉回 running。这些中间终态不代表任务完成，若按 phase 边沿
// 弹完成通知会变成"目标未完成，任务继续"却响完成音（见 docs/specs/task-notification-goal-iteration.md）。
const GOAL_STILL_ITERATING_STATUSES = new Set<NonNullable<SessionSummary["goalStatus"]>>([
  "active",
  "verifying",
  "notSatisfied",
]);

// 该帧是否已经向用户发出过"完成"通知：终态 completed 且 goalStatus 不在迭代中间态集合。
// 被静默的迭代中间帧（active/verifying/notSatisfied）视为未通知，这样 verifier 通过的
// (completedSuccess, verified) 帧——其 phase 与上一帧同为 completedSuccess——仍能补发
// 真完成通知，校验中用户 stop 落到的 (completedInterrupted, paused) 也不会被同相去重吞掉。
function impliesCompletedNotification(session: SessionSummary): boolean {
  return session.goalStatus === undefined || !GOAL_STILL_ITERATING_STATUSES.has(session.goalStatus);
}

export function collectTerminalTaskNotificationPayloads(params: {
  previousBySessionId: ReadonlyMap<string, SessionSummary>;
  sessions: readonly SessionSummary[];
  formatMessage: FormatMessage;
}): TaskNotificationPayload[] {
  const payloads: TaskNotificationPayload[] = [];
  for (const session of params.sessions) {
    const status = terminalStatusForPhase(session.phase);
    if (!status) continue;

    const previous = params.previousBySessionId.get(session.sessionId);
    if (!previous) continue;

    const previousStatus = terminalStatusForPhase(previous.phase);
    if (status === "completed") {
      // goal 仍在自主迭代时静默完成通知；verified/paused 与无 goalStatus 的普通会话维持现状。
      if (!impliesCompletedNotification(session)) continue;
      // 同相去重只对"上一帧真的通知过完成"生效；上一帧是被静默的迭代中间态时，
      // 本帧是用户感知真完成/真中断的唯一时机。
      if (previousStatus === "completed" && impliesCompletedNotification(previous)) continue;
    } else if (previousStatus === status) {
      continue;
    }

    payloads.push(terminalPayloadForSession(session, status, params.formatMessage));
  }
  return payloads;
}

function pendingInteractionPayload(params: {
  snapshot: ConversationSnapshot;
  interaction: PendingInteraction;
  formatMessage: FormatMessage;
}): TaskNotificationPayload | null {
  const { snapshot, interaction, formatMessage } = params;
  const requestId = interaction.interactionId;
  const taskId = snapshot.sessionId;
  const taskTitle = snapshot.meta.title;

  // workspace Hook review 的唯一入口是 Settings；不得把它伪装成
  // permission/elicitation 系统通知。
  if (interaction.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (interaction.payload.kind === "permission") {
    return {
      taskId,
      status: "permission_request",
      requestId,
      title: formatMessage({ id: "notification.permissionRequired" }),
      body:
        interaction.payload.summary.trim() ||
        taskTitleBody(taskTitle, "notification.permissionRequired", formatMessage),
    };
  }

  return {
    taskId,
    status: "elicitation_request",
    requestId,
    title: formatMessage({ id: "notification.inputRequired" }),
    body:
      interaction.payload.prompt.trim() ||
      taskTitleBody(taskTitle, "notification.inputRequired", formatMessage),
  };
}

export function collectPendingInteractionNotificationPayloads(params: {
  snapshot: ConversationSnapshot;
  seenRequestIds: ReadonlySet<string>;
  formatMessage: FormatMessage;
}): TaskNotificationPayload[] {
  return params.snapshot.pendingInteractions
    .filter((interaction) => !params.seenRequestIds.has(interaction.interactionId))
    .flatMap((interaction) => {
      const payload = pendingInteractionPayload({
        snapshot: params.snapshot,
        interaction,
        formatMessage: params.formatMessage,
      });
      return payload ? [payload] : [];
    });
}
