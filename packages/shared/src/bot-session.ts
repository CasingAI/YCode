import { z } from "zod";

/** Bot 岗位会话种类。不是协作档，不得写入 executionPermissionModeSchema。 */
export const BOT_SESSION_KIND = "bot-session" as const;
export type BotSessionKind = typeof BOT_SESSION_KIND;

export const BOT_SEND_MESSAGE_TOOL = "bot_send_message";
export const BOT_ASK_USER_TOOL = "bot_ask_user";
export const BOT_MEMORY_TOOL = "bot_memory";
export const BOT_TASK_TOOL = "bot_task";

export const BOT_IDLE_HOUSEKEEP_MS = 15 * 60 * 1000;
export const BOT_HOUSEKEEP_SENTINEL = "⟦bot-housekeep⟧";
export const BOT_HOUSEKEEP_PROMPT = `${BOT_HOUSEKEEP_SENTINEL} Idle housekeep: compact if useful, write durable notes with bot_memory, and do not call bot_send_message or bot_ask_user.`;
export const BOT_TASK_WATCH_SENTINEL = "⟦bot-task-watch⟧";
export const BOT_NOTIFICATION_TASK_PREFIX = "bot:";
export const BOT_TASK_WATCH_EVENTS = ["end", "waiting_for_user"] as const;
export type BotTaskWatchEvent = (typeof BOT_TASK_WATCH_EVENTS)[number];

/** createSessionId 会再加 sess_ 前缀，岗位会话实际 id 为 sess_botsess_<uuid>。 */
export function isBotSessionRecordId(sessionId: string): boolean {
  return sessionId.includes("botsess_");
}

export function isBotHousekeepUserText(text: string | undefined): boolean {
  return Boolean(text?.startsWith(BOT_HOUSEKEEP_SENTINEL));
}

export function isBotTaskWatchUserText(text: string | undefined): boolean {
  return Boolean(text?.startsWith(BOT_TASK_WATCH_SENTINEL));
}

export function botNotificationTaskId(botId: string): string {
  return `${BOT_NOTIFICATION_TASK_PREFIX}${botId}`;
}

export function parseBotNotificationTaskId(taskId: string): string | undefined {
  if (!taskId.startsWith(BOT_NOTIFICATION_TASK_PREFIX)) {
    return undefined;
  }
  const botId = taskId.slice(BOT_NOTIFICATION_TASK_PREFIX.length).trim();
  return botId || undefined;
}

export function formatBotTaskWatchPrompt(input: {
  event: BotTaskWatchEvent;
  sessionId: string;
  outcome?: "completed" | "failed" | "stopped";
  interactionId?: string;
  toolName?: string;
  summary?: string;
}): string {
  const header = [
    BOT_TASK_WATCH_SENTINEL,
    input.event,
    `sessionId=${input.sessionId}`,
    input.outcome ? `outcome=${input.outcome}` : undefined,
    input.interactionId ? `interactionId=${input.interactionId}` : undefined,
    input.toolName ? `tool=${input.toolName}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const body =
    input.event === "end"
      ? `The watched task ${input.sessionId} has ended (${input.outcome ?? "completed"}). Tell the user with bot_send_message if they should know. You may answer remaining questions with bot_task answer or execute a waiting plan with bot_task execute_plan.`
      : `The watched task ${input.sessionId} is waiting for a user decision (${input.toolName ?? "question"}). Summarize to the user with bot_send_message. Use bot_task answer or bot_task execute_plan if you should act for them. Permission requests are not this event.`;
  const extra = input.summary?.trim() ? `\n${input.summary.trim()}` : "";
  return `${header}\n${body}${extra}`;
}

export function parseBotTaskWatchEvent(text: string | undefined): BotTaskWatchEvent | undefined {
  if (!text || !isBotTaskWatchUserText(text)) {
    return undefined;
  }
  const token = text.slice(BOT_TASK_WATCH_SENTINEL.length).trim().split(/\s+/u)[0];
  return token === "end" || token === "waiting_for_user" ? token : undefined;
}

export function parseBotTaskWatchSessionId(text: string | undefined): string | undefined {
  if (!text || !isBotTaskWatchUserText(text)) {
    return undefined;
  }
  const match = /\bsessionId=(\S+)/u.exec(text);
  const sessionId = match?.[1]?.trim();
  return sessionId || undefined;
}

export const BOT_SEND_MESSAGE_SOFT_LIMIT = 120;
export const BOT_SEND_MESSAGE_HARD_LIMIT = 1000;

export const botSendMessageInputSchema = z.object({
  text: z.string().min(1).max(BOT_SEND_MESSAGE_HARD_LIMIT),
});

export const botAskChoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const botAskUserInputSchema = z.object({
  text: z.string().min(1).max(BOT_SEND_MESSAGE_HARD_LIMIT),
  choices: z.array(botAskChoiceSchema).min(1).max(2),
});

export type BotSendMessageInput = z.infer<typeof botSendMessageInputSchema>;
export type BotAskUserInput = z.infer<typeof botAskUserInputSchema>;

export function botNotesRelativePath(botId: string): string {
  return `bots/${botId}/memory.md`;
}

export function botNotesDisplayPath(botId: string): string {
  return `~/.zcode/${botNotesRelativePath(botId)}`;
}
