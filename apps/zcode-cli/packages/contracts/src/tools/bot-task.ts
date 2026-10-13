import { z } from "zod";
import { BOT_TASK_TOOL, BOT_TASK_WATCH_EVENTS } from "@zcode/shared";
import { toToolJsonSchema } from "./json-schema.js";

export const BOT_TASK_TOOL_NAME = BOT_TASK_TOOL;

const botTaskActionSchema = z.enum([
  "open",
  "relay",
  "stop",
  "set_mode",
  "subscribe",
  "answer",
  "execute_plan",
]);

export const BotTaskInputSchema = z
  .object({
    action: botTaskActionSchema,
    title: z.string().min(1).max(120).optional(),
    sessionId: z.string().min(1).optional(),
    text: z.string().min(1).max(32_000).optional(),
    mode: z.enum(["plan", "readonly", "yolo", "bare"]).optional(),
    events: z.array(z.enum(BOT_TASK_WATCH_EVENTS)).min(1).max(2).optional(),
    interactionId: z.string().min(1).optional(),
    answers: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type BotTaskInput = z.infer<typeof BotTaskInputSchema>;
export const BotTaskInputJsonSchema = toToolJsonSchema(BotTaskInputSchema);

export const BotTaskOutputSchema = z
  .object({
    action: botTaskActionSchema,
    sessionId: z.string().min(1),
    title: z.string().optional(),
    mode: z.enum(["plan", "readonly", "yolo", "bare"]).optional(),
    events: z.array(z.enum(BOT_TASK_WATCH_EVENTS)).optional(),
  })
  .strict();
export type BotTaskOutput = z.infer<typeof BotTaskOutputSchema>;
export const BotTaskOutputJsonSchema = toToolJsonSchema(BotTaskOutputSchema);
