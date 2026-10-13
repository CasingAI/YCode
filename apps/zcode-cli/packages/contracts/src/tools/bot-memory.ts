import { z } from "zod";
import { BOT_MEMORY_TOOL } from "@zcode/shared";
import { toToolJsonSchema } from "./json-schema.js";

export const BOT_MEMORY_TOOL_NAME = BOT_MEMORY_TOOL;

export const BotMemoryInputSchema = z
  .object({
    action: z.enum(["read", "write"]),
    text: z.string().max(32_000).optional(),
  })
  .strict();
export type BotMemoryInput = z.infer<typeof BotMemoryInputSchema>;
export const BotMemoryInputJsonSchema = toToolJsonSchema(BotMemoryInputSchema);

export const BotMemoryOutputSchema = z
  .object({
    path: z.string().min(1),
    text: z.string(),
  })
  .strict();
export type BotMemoryOutput = z.infer<typeof BotMemoryOutputSchema>;
export const BotMemoryOutputJsonSchema = toToolJsonSchema(BotMemoryOutputSchema);
