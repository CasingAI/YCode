import {
  BOT_TASK_BUSY_ERROR,
  BOT_TASK_TOOL_NAME,
  BotTaskInputJsonSchema,
  BotTaskInputSchema,
  BotTaskOutputJsonSchema,
  BotTaskOutputSchema,
  CoreErrorType,
  createCoreError,
  type BotTaskOutput,
  type CollaborationMode,
} from "@zcode/contracts";
import { BOT_TASK_WATCH_EVENTS, type BotTaskWatchEvent } from "@zcode/shared";
import type { ToolEntry, ToolHandler } from "../types.js";

const BOT_TASK_DESCRIPTION = [
  "Operate async task-list sessions from this Bot job session.",
  "open: create a Bare task with a short title. Stay on the Bot page.",
  "relay: send text to an existing task. If that task is busy, this tool fails; do not treat it as success.",
  "stop: stop a running task.",
  "set_mode: switch that task to plan, readonly (Ask), yolo (Agent), or bare.",
  "subscribe: watch that task for end (completed / failed / stopped) and/or waiting_for_user (AskUserQuestion or plan approval). Permission prompts are not this event. Returns immediately; does not occupy the Worker slot.",
  "answer: answer a waiting AskUserQuestion on that task.",
  "execute_plan: approve a waiting plan on that task and start implementation.",
  "Do not use this to talk to the user.",
].join("\n");

const botTaskHandler: ToolHandler = async (input, context) => {
  const parsed = BotTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_task requires a valid action", {
      recoverable: true,
      context: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  const port = context.botTaskPort;
  if (!port) {
    throw createCoreError(CoreErrorType.ConfigurationError, "bot_task is not configured", {
      recoverable: false,
    });
  }
  const botId = context.botId?.trim();
  if (!botId) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_task requires a Bot identity", {
      recoverable: false,
    });
  }
  try {
    if (parsed.data.action === "open") {
      const title = parsed.data.title?.trim();
      if (!title) {
        throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_task open requires title", {
          recoverable: true,
        });
      }
      const opened = await port.openBareTask({
        title,
        botId,
        ...(parsed.data.text?.trim() ? { firstMessage: parsed.data.text.trim() } : {}),
      });
      return {
        action: "open",
        sessionId: opened.sessionId,
        title: opened.title,
      } satisfies BotTaskOutput;
    }
    const sessionId = parsed.data.sessionId?.trim();
    if (!sessionId) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_task requires sessionId", {
        recoverable: true,
      });
    }
    if (parsed.data.action === "relay") {
      const text = parsed.data.text?.trim();
      if (!text) {
        throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_task relay requires text", {
          recoverable: true,
        });
      }
      const relayed = await port.relayText({ sessionId, text });
      return { action: "relay", sessionId: relayed.sessionId } satisfies BotTaskOutput;
    }
    if (parsed.data.action === "stop") {
      const stopped = await port.stopTask({ sessionId });
      return { action: "stop", sessionId: stopped.sessionId } satisfies BotTaskOutput;
    }
    if (parsed.data.action === "subscribe") {
      const events = uniqueWatchEvents(parsed.data.events);
      const subscribed = await port.subscribe({ sessionId, events });
      return {
        action: "subscribe",
        sessionId: subscribed.sessionId,
        events: subscribed.events,
      } satisfies BotTaskOutput;
    }
    if (parsed.data.action === "answer") {
      const answered = await port.answerQuestion({
        sessionId,
        ...(parsed.data.interactionId?.trim()
          ? { interactionId: parsed.data.interactionId.trim() }
          : {}),
        ...(parsed.data.answers ? { answers: parsed.data.answers } : {}),
        ...(parsed.data.text?.trim() ? { freeText: parsed.data.text.trim() } : {}),
      });
      return { action: "answer", sessionId: answered.sessionId } satisfies BotTaskOutput;
    }
    if (parsed.data.action === "execute_plan") {
      const executed = await port.executePlan({ sessionId });
      return { action: "execute_plan", sessionId: executed.sessionId } satisfies BotTaskOutput;
    }
    const mode = parsed.data.mode as CollaborationMode | undefined;
    if (!mode) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, "bot_task set_mode requires mode", {
        recoverable: true,
      });
    }
    const updated = await port.setTaskMode({ sessionId, mode });
    return {
      action: "set_mode",
      sessionId: updated.sessionId,
      mode: updated.mode,
    } satisfies BotTaskOutput;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === BOT_TASK_BUSY_ERROR || message.includes(BOT_TASK_BUSY_ERROR)) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Target task is busy; relay failed. Stop it, wait, or subscribe instead.",
        { recoverable: true },
      );
    }
    throw error;
  }
};

function uniqueWatchEvents(events: BotTaskWatchEvent[] | undefined): BotTaskWatchEvent[] {
  if (!events || events.length === 0) {
    return [...BOT_TASK_WATCH_EVENTS];
  }
  return [...new Set(events)];
}

export const botTaskToolEntry: ToolEntry = {
  capability: "Create and operate async Bare tasks from a Bot job session",
  metadata: {
    name: BOT_TASK_TOOL_NAME,
    description: BOT_TASK_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: 8_000,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: botTaskHandler,
  inputSchema: BotTaskInputJsonSchema,
  outputSchema: BotTaskOutputJsonSchema,
  runtimeInputSchema: BotTaskInputSchema,
  runtimeOutputSchema: BotTaskOutputSchema,
  permission: {
    permission: "session.botTask",
    reason: "bot_task creates or operates task-list sessions from this Bot",
    riskLevel: "medium",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 8_000,
    maxModelBytes: 8_000,
    strategy: "truncate",
    preview: { maxBytes: 4_000, direction: "head" },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "bot_task was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
