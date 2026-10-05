import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_OUTPUT_TOOL_NAME = "TaskOutput";
export const TASK_OUTPUT_ALIASES = [
  "AgentOutputTool",
  "BashOutputTool",
  "AgentOutput",
  "BashOutput",
] as const;

export const TASK_OUTPUT_PROVIDER_DESCRIPTION = `DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For historical local_agent tasks: use TaskOutput only to inspect the legacy task; new Agent calls return their result in the parent turn.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Retrieves output from a running or completed background shell, workflow, historical agent, or remote session
- Takes a task_id parameter identifying the task (the id comes from the result of the call that started the task)
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- timeout is how long block=true waits, in ms. Range 0-300000, default 15000. The result reports the actual waited_ms; on timeout it means the task is still running, so call again with a larger timeout or poll with block=false
- Does not start a new Agent subagent`;

export const TaskOutputInputSchema = z
  .object({
    task_id: z.string().describe("The task ID to get output from"),
    block: semanticBoolean(z.boolean().default(true)).describe("Whether to wait for completion"),
    timeout: z.number().min(0).max(300_000).default(15_000).describe("Max wait time in ms"),
  })
  .strict();

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export const TaskOutputInputJsonSchema = {
  ...toToolJsonSchema(TaskOutputInputSchema),

  // 的 provider schema 仍要求模型显式传入 task_id、block 和 timeout。
  required: ["task_id", "block", "timeout"],
};

export const TaskOutputTaskSchema = z
  .object({
    task_id: z.string(),
    task_type: z.string(),
    status: z.string(),
    description: z.string(),
    output: z.string(),
    exitCode: z.number().nullable().optional(),
    error: z.string().optional(),
    prompt: z.string().optional(),
    result: z.string().optional(),
    outputFile: z.string().optional(),
  })
  .strict();

export type TaskOutputTask = z.infer<typeof TaskOutputTaskSchema>;

export const TaskOutputResultSchema = z
  .object({
    retrieval_status: z.enum(["success", "not_ready", "timeout"]),
    /**
     * 本次实际等待的毫秒数。模型对时间没有概念，只给「超时」不给时长，它无法判断
     * 该调大 timeout 重试还是改用 block=false 轮询。
     *
     * 可选是为了让既有的持久化结果仍能解析（`.strict()` 下老结果缺这个 key 仍通过）。
     */
    waited_ms: z.number().int().min(0).optional(),
    task: TaskOutputTaskSchema.nullable(),
  })
  .strict();

export type TaskOutputResult = z.infer<typeof TaskOutputResultSchema>;

export const TaskOutputResultJsonSchema = toToolJsonSchema(TaskOutputResultSchema);

function semanticBoolean(
  schema: z.ZodDefault<z.ZodBoolean>,
): z.ZodEffects<z.ZodDefault<z.ZodBoolean>, boolean, unknown> {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, schema);
}
