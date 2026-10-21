import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_STOP_TOOL_NAME = "TaskStop";

export const TaskStopInputSchema = z
  .object({
    task_id: z.string().optional().describe("The ID of the background task to stop"),
    shell_id: z
      .string()
      .optional()
      .describe("Deprecated: use task_id instead"),
  })
  .strict();

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export const TaskStopInputJsonSchema = toToolJsonSchema(TaskStopInputSchema);

export const TaskStopOutputSchema = z
  .object({
    message: z.string(),
    task_id: z.string(),
    task_type: z.string(),
    command: z.string().optional(),
    // 被停止任务的人类可读描述（模型当初写的那句话）。与 command 是两件事：
    // command 是命令原文，description 是这张卡片该给人看的话。
    description: z.string().optional(),
  })
  .strict();

export type TaskStopOutput = z.infer<typeof TaskStopOutputSchema>;

export const TaskStopOutputJsonSchema = toToolJsonSchema(TaskStopOutputSchema);
