import { z } from "zod";
import {
  BOT_ASK_USER_TOOL,
  BOT_SEND_MESSAGE_HARD_LIMIT,
  BOT_SEND_MESSAGE_TOOL,
} from "@zcode/shared";
import { toToolJsonSchema } from "./json-schema.js";

export const BOT_SEND_MESSAGE_TOOL_NAME = BOT_SEND_MESSAGE_TOOL;
export const BOT_ASK_USER_TOOL_NAME = BOT_ASK_USER_TOOL;

export const BotSendMessageInputSchema = z
  .object({
    text: z.string().min(1).max(BOT_SEND_MESSAGE_HARD_LIMIT),
  })
  .strict();
export type BotSendMessageInput = z.infer<typeof BotSendMessageInputSchema>;
export const BotSendMessageInputJsonSchema = toToolJsonSchema(BotSendMessageInputSchema);

export const BotSendMessageOutputSchema = z
  .object({
    delivered: z.literal(true),
    text: z.string().min(1).max(BOT_SEND_MESSAGE_HARD_LIMIT),
  })
  .strict();
export type BotSendMessageOutput = z.infer<typeof BotSendMessageOutputSchema>;
export const BotSendMessageOutputJsonSchema = toToolJsonSchema(BotSendMessageOutputSchema);

export const BotAskChoiceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

export const BotAskUserInputSchema = z
  .object({
    text: z.string().min(1).max(BOT_SEND_MESSAGE_HARD_LIMIT),
    choices: z.array(BotAskChoiceSchema).min(1).max(2),
  })
  .strict();
export type BotAskUserInput = z.infer<typeof BotAskUserInputSchema>;
export const BotAskUserInputJsonSchema = toToolJsonSchema(BotAskUserInputSchema);

export const BotAskUserAnsweredInputSchema = BotAskUserInputSchema.extend({
  selectedId: z.string().min(1),
}).strict();
export type BotAskUserAnsweredInput = z.infer<typeof BotAskUserAnsweredInputSchema>;

export const BotAskUserOutputSchema = z
  .object({
    text: z.string().min(1).max(BOT_SEND_MESSAGE_HARD_LIMIT),
    selectedId: z.string().min(1),
    selectedLabel: z.string().min(1),
  })
  .strict();
export type BotAskUserOutput = z.infer<typeof BotAskUserOutputSchema>;
export const BotAskUserOutputJsonSchema = toToolJsonSchema(BotAskUserOutputSchema);
