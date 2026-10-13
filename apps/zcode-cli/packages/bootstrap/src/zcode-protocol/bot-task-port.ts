import {
  ASK_USER_QUESTION_TOOL_NAME,
  BOT_TASK_BUSY_ERROR,
  SessionEventType,
  type BotTaskPort,
  type PermissionRequestedPayload,
  type SessionEvent,
  type TurnCompletePayload,
} from "@zcode/contracts";
import { formatBotTaskWatchPrompt, type BotTaskWatchEvent } from "@zcode/shared";
import { isPlanApprovalToolName } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolAgentServerContext, ZCodeProtocolSessionRecord } from "./server-types.js";

interface BotTaskWatch {
  botSessionId: string;
  botId: string;
  events: ReadonlySet<BotTaskWatchEvent>;
  lastFiredKey?: string;
}

const watchesByTarget = new Map<string, BotTaskWatch[]>();

export function createBotTaskPort(
  context: ZCodeProtocolAgentServerContext,
  hooks: {
    getOwnRecord: () => ZCodeProtocolSessionRecord | undefined;
    openBareTask: BotTaskPort["openBareTask"];
  },
): BotTaskPort {
  return {
    openBareTask: hooks.openBareTask,
    async relayText(input) {
      const target = requireTaskSession(context, input.sessionId);
      if (target.activeAbortController || target.app.runtime.getActiveTurnInfo()) {
        throw new Error(BOT_TASK_BUSY_ERROR);
      }
      await target.app.sendInput(input.text, { relayedBy: "bot" });
      return { sessionId: input.sessionId };
    },
    async stopTask(input) {
      const target = requireTaskSession(context, input.sessionId);
      target.activeAbortController?.abort(new Error("Bot stopped the task"));
      return { sessionId: input.sessionId };
    },
    async setTaskMode(input) {
      const target = requireTaskSession(context, input.sessionId);
      await target.app.setMode(input.mode);
      return { sessionId: input.sessionId, mode: input.mode };
    },
    async subscribe(input) {
      const parent = hooks.getOwnRecord();
      if (!parent) {
        throw new Error("Bot session is not ready");
      }
      requireTaskSession(context, input.sessionId);
      const events = new Set(input.events);
      const next = (watchesByTarget.get(input.sessionId) ?? []).filter(
        (watch) => watch.botSessionId !== parent.app.sessionId,
      );
      next.push({
        botSessionId: parent.app.sessionId,
        botId: parent.creatorBotId ?? "",
        events,
      });
      watchesByTarget.set(input.sessionId, next);
      return { sessionId: input.sessionId, events: [...events] };
    },
    async answerQuestion(input) {
      requireTaskSession(context, input.sessionId);
      const interactionId = input.interactionId?.trim() ?? findWaitingAskId(context, input.sessionId);
      if (!interactionId) {
        throw new Error("No waiting question on that task");
      }
      const delivered = context.v4Interactions.resolve(interactionId, {
        action: "accept",
        ...(input.answers ? { content: { answers: input.answers } } : {}),
        ...(input.freeText?.trim() ? { freeText: input.freeText.trim() } : {}),
      });
      if (!delivered) {
        throw new Error("Waiting question was already resolved");
      }
      return { sessionId: input.sessionId };
    },
    async executePlan(input) {
      requireTaskSession(context, input.sessionId);
      const interactionId = findWaitingPlanId(context, input.sessionId);
      if (!interactionId) {
        throw new Error("No waiting plan on that task");
      }
      const delivered = context.v4Interactions.resolve(interactionId, { action: "accept" });
      if (!delivered) {
        throw new Error("Waiting plan was already resolved");
      }
      return { sessionId: input.sessionId };
    },
  };
}

export function dispatchBotTaskWatches(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): void {
  if (record.taskType === "bot-session") {
    return;
  }
  const watches = watchesByTarget.get(record.app.sessionId);
  if (!watches || watches.length === 0) {
    return;
  }
  const fired = classifyWatchEvent(event);
  if (!fired) {
    return;
  }
  const eventKey = `${event.type}:${event.id}`;
  for (const watch of watches) {
    if (!watch.events.has(fired.event) || watch.lastFiredKey === eventKey) {
      continue;
    }
    watch.lastFiredKey = eventKey;
    wakeBotSession(context, watch, record.app.sessionId, fired);
  }
}

function requireTaskSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): ZCodeProtocolSessionRecord {
  const target = context.sessions.get(sessionId);
  if (!target) {
    throw new Error("Task session not found");
  }
  if (target.taskType === "bot-session") {
    throw new Error("Cannot operate a Bot job session as a task");
  }
  return target;
}

function classifyWatchEvent(
  event: SessionEvent,
):
  | { event: "end"; outcome: "completed" | "failed" | "stopped" }
  | {
      event: "waiting_for_user";
      interactionId?: string;
      toolName?: string;
      summary?: string;
    }
  | undefined {
  if (event.type === SessionEventType.TurnComplete) {
    const payload = event.payload as TurnCompletePayload;
    if (payload.resultType === "cancelled") {
      return { event: "end", outcome: "stopped" };
    }
    if (payload.resultType.startsWith("error_")) {
      return { event: "end", outcome: "failed" };
    }
    return { event: "end", outcome: "completed" };
  }
  if (event.type === SessionEventType.TurnError) {
    return { event: "end", outcome: "failed" };
  }
  if (event.type !== SessionEventType.PermissionRequested) {
    return undefined;
  }
  const payload = event.payload as PermissionRequestedPayload;
  if (
    payload.toolName !== ASK_USER_QUESTION_TOOL_NAME &&
    !isPlanApprovalToolName(payload.toolName)
  ) {
    return undefined;
  }
  return {
    event: "waiting_for_user",
    ...(payload.requestId ? { interactionId: payload.requestId } : {}),
    toolName: payload.toolName,
    summary: payload.reason,
  };
}

function wakeBotSession(
  context: ZCodeProtocolAgentServerContext,
  watch: BotTaskWatch,
  targetSessionId: string,
  fired:
    | { event: "end"; outcome: "completed" | "failed" | "stopped" }
    | {
        event: "waiting_for_user";
        interactionId?: string;
        toolName?: string;
        summary?: string;
      },
): void {
  const bot = context.sessions.get(watch.botSessionId);
  if (!bot || bot.taskType !== "bot-session") {
    return;
  }
  const prompt = formatBotTaskWatchPrompt({
    event: fired.event,
    sessionId: targetSessionId,
    ...(fired.event === "end" ? { outcome: fired.outcome } : {}),
    ...(fired.event === "waiting_for_user"
      ? {
          ...(fired.interactionId ? { interactionId: fired.interactionId } : {}),
          ...(fired.toolName ? { toolName: fired.toolName } : {}),
          ...(fired.summary ? { summary: fired.summary } : {}),
        }
      : {}),
  });
  const busy = Boolean(bot.activeAbortController || bot.app.runtime.getActiveTurnInfo());
  void bot.app
    .sendInput(prompt, busy ? { queueDelivery: "queue" } : undefined)
    .catch((error: unknown) => {
      context.logger?.warn?.("bot_task subscribe wake failed", {
        error: error instanceof Error ? error.message : String(error),
        botSessionId: watch.botSessionId,
        targetSessionId,
      });
    });
}

function findWaitingAskId(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): string | undefined {
  return context.v4Gateway
    ?.getPendingInteractions(sessionId)
    .find(
      (interaction) =>
        interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === ASK_USER_QUESTION_TOOL_NAME,
    )?.interactionId;
}

function findWaitingPlanId(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): string | undefined {
  return context.v4Gateway
    ?.getPendingInteractions(sessionId)
    .find(
      (interaction) =>
        interaction.payload.kind === "userInput" &&
        isPlanApprovalToolName(interaction.payload.toolName),
    )?.interactionId;
}
