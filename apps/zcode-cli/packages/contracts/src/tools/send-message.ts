import { z } from "zod";
import { AgentAttachmentsSchema } from "./agent-attachment.js";
import { AgentTerminalOutputSchema } from "./agent.js";
import { toToolJsonSchema } from "./json-schema.js";

export const SEND_MESSAGE_TOOL_NAME = "RelayToSubagent";
export const SEND_MESSAGE_MAX_CONTENT_CHARS = 20_000;

export const SendMessageInputSchema = z
  .object({
    to: z
      .string()
      .min(1)
      .max(200)
      .describe("Recipient: local agent ID returned by Agent (format agent_<uuid>)."),
    summary: z
      .string()
      .min(1)
      .max(200)
      .describe("A 5-10 word summary shown as a preview in the UI."),
    message: z
      .string()
      .min(1)
      .max(SEND_MESSAGE_MAX_CONTENT_CHARS)
      .describe("Plain text message content"),
    mode: z
      .enum(["Ask", "Agent"])
      .optional()
      .describe(
        "Ask or Agent for a finished Worker. Omitted keeps the current mode. Refused on running agents and on non-Worker types.",
      ),
    attachments: AgentAttachmentsSchema.describe(
      "Optional images/files for the agent to see. Images arrive as image content blocks.",
    ),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const SendMessageInputJsonSchema = toToolJsonSchema(SendMessageInputSchema);

export const SendMessageOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    messageId: z.string(),
    agentId: z.string().optional(),
    delivery: z
      .enum(["queued", "steered", "resumed_foreground", "resumed_background"])
      .optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    outputFile: z.string().optional(),
    taskId: z.string().optional(),
    continuation: AgentTerminalOutputSchema.optional(),
  })
  .strict();

export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

export const SendMessageOutputJsonSchema = toToolJsonSchema(SendMessageOutputSchema);
