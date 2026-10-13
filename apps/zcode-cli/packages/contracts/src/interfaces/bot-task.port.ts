import type { BotTaskWatchEvent } from "@zcode/shared";
import type { CollaborationMode } from "./session.port.js";

export interface BotTaskPort {
  openBareTask(input: {
    title: string;
    botId: string;
    firstMessage?: string;
  }): Promise<{ sessionId: string; title: string }>;
  relayText(input: { sessionId: string; text: string }): Promise<{ sessionId: string }>;
  stopTask(input: { sessionId: string }): Promise<{ sessionId: string }>;
  setTaskMode(input: {
    sessionId: string;
    mode: CollaborationMode;
  }): Promise<{ sessionId: string; mode: CollaborationMode }>;
  subscribe(input: {
    sessionId: string;
    events: BotTaskWatchEvent[];
  }): Promise<{ sessionId: string; events: BotTaskWatchEvent[] }>;
  answerQuestion(input: {
    sessionId: string;
    interactionId?: string;
    answers?: Record<string, unknown>;
    freeText?: string;
  }): Promise<{ sessionId: string }>;
  executePlan(input: { sessionId: string }): Promise<{ sessionId: string }>;
}

export const BOT_TASK_BUSY_ERROR = "TARGET_BUSY";
