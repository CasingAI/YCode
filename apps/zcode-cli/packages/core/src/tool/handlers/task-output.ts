import {
  CoreErrorType,
  SessionEventType,
  TASK_OUTPUT_ALIASES,
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputInputSchema,
  TaskOutputResultSchema,
  TaskOutputResultJsonSchema,
  TaskOutputInputJsonSchema,
  createCoreError,
  type MessageWithParts,
  type SubagentIdentityResolution,
  type TaskOutputInput,
  type TaskOutputResult,
  type TaskOutputTask,
  type TextPart,
} from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import { formatPersistedOutputEnvelope } from "../result-persistence-format.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputValidationContext,
  ToolInputValidationResult,
  ToolPersistedModelContentInput,
} from "../types.js";
import { formatCompactFileSize, projectTask, throwIfAborted } from "./task-output-projection.js";

const TASK_OUTPUT_DEFAULT_LENGTH = 32_000;
const TASK_OUTPUT_MAX_LENGTH = 160_000;
const TASK_OUTPUT_PERSIST_THRESHOLD_CHARS = 100_000;
const TASK_OUTPUT_RESULT_BUDGET_BYTES = 400_000;
const TASK_OUTPUT_PERSIST_PREVIEW_CHARS = 2_000;
const TASK_OUTPUT_POLL_INTERVAL_MS = 100;
const TASK_OUTPUT_ERROR_CODE = {
  TASK_ID_REQUIRED: 1,
  TASK_NOT_FOUND: 2,
} as const;

/** subagent runner 生成的 agentId 前缀；用于把 durable 查询限制在 Agent 任务上。 */
const SUBAGENT_TASK_ID_PREFIX = "agent_";

const taskOutputHandler: ToolHandler = async (input, context) => {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  const inputFailure = getTaskOutputInputFailure(parsed, context.runtimeTaskRegistry);
  if (inputFailure) return inputFailure;

  const registry = requireRuntimeTaskRegistry(context);

  const initialTask =
    registry.get(parsed.task_id) ?? (await loadDurableAgentTaskSnapshot(parsed.task_id, context));
  if (!initialTask) {
    return taskOutputFailure(
      TASK_OUTPUT_ERROR_CODE.TASK_NOT_FOUND,
      `No task found with ID: ${parsed.task_id}`,
    );
  }

  if (!parsed.block) {
    // 不等待也要报真实耗时：模型据此判断「再等一次值不值」。
    const startedAt = Date.now();
    if (isTaskActive(initialTask.status)) {
      return taskOutputResult("not_ready", await projectTask(initialTask, context), {
        waited_ms: Date.now() - startedAt,
      });
    }
    const projectedTask = await projectTask(initialTask, context);
    // notified 是完成结果已成功交付的 claim；投影前写入会在读取失败或
    // abort 时吞掉后续 completion notification。异步投影不会被外层取消竞态强制
    // 停止，因此 await 返回后必须再次检查 signal，再提交 claim。
    throwIfAborted(context.abortSignal);
    markTaskNotified(initialTask, context);
    return taskOutputResult("success", projectedTask, { waited_ms: Date.now() - startedAt });
  }

  await emitWaitingProgress(context);
  const waitStartedAt = Date.now();
  const task = await waitForTask(parsed.task_id, parsed.timeout, context);
  // 只量到等待结束，不含后面的 projectTask 读文件——那是「读输出」的耗时，
  // 混进来会让模型以为等待超了预算。
  const waited_ms = { waited_ms: Date.now() - waitStartedAt };
  if (!task) {
    return taskOutputResult("timeout", null, waited_ms);
  }
  if (isTaskActive(task.status)) {
    return taskOutputResult("timeout", await projectTask(task, context), waited_ms);
  }
  const projectedTask = await projectTask(task, context);
  throwIfAborted(context.abortSignal);
  markTaskNotified(task, context);
  return taskOutputResult("success", projectedTask, waited_ms);
};

export const taskOutputToolEntry: ToolEntry = {
  aliases: TASK_OUTPUT_ALIASES,
  capability: "read output/logs from a background task",
  maxModelChars: TASK_OUTPUT_PERSIST_THRESHOLD_CHARS,
  metadata: {
    name: TASK_OUTPUT_TOOL_NAME,
    description: TASK_OUTPUT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskOutputHandler,
  validateInput: validateTaskOutputInput,
  formatModelContent: formatTaskOutputModelContent,
  formatPersistedModelContent: formatPersistedTaskOutputModelContent,
  inputSchema: TaskOutputInputJsonSchema,
  outputSchema: TaskOutputResultJsonSchema,
  runtimeInputSchema: TaskOutputInputSchema,
  runtimeOutputSchema: TaskOutputResultSchema,
  permission: {
    permission: "taskOutput",
    reason: "TaskOutput reads a background task from the current runtime",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    maxModelBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  resultArtifactContentType: "text/plain",
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TaskOutput was cancelled while waiting for the task",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function taskOutputFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

/**
 * live registry 未命中时按持久化身份读回 child transcript，构造只读的历史终态 snapshot。
 *
 * 与 SendMessage 冷恢复同源：同一个 SessionStore 身份索引、同一套 child taskType 与
 * workspace 校验。否则会出现"SendMessage 能续、TaskOutput 却报找不到"的不一致。
 *
 * 状态不猜：只把 child transcript 的最后一条 assistant 文本当作结果，失败证据缺失时
 * 报 completed 之外的状态没有依据，所以这里只区分"有终态文本"和"没有"。
 * 这个 snapshot 不注册进 registry，纯粹用于本次投影。
 */
async function loadDurableAgentTaskSnapshot(
  taskId: string,
  context: ToolExecutionContext,
): Promise<RuntimeTaskSnapshot | undefined> {
  const sessionStore = context.sessionStore;
  if (!sessionStore?.resolveSubagentIdentity) return undefined;
  if (!taskId.startsWith(SUBAGENT_TASK_ID_PREFIX)) return undefined;

  let resolution: SubagentIdentityResolution | null;
  try {
    resolution = await sessionStore.resolveSubagentIdentity(taskId);
  } catch {
    // 存储读失败不等于任务不存在，但也不该在这里编造一个结果。
    return undefined;
  }
  if (!resolution) return undefined;

  const { binding, child } = resolution;
  if (child.taskType !== "subagent_child") return undefined;
  if (String(child.id) !== binding.childSessionId) return undefined;

  const messages = await sessionStore.messages({ sessionID: child.id });
  const lastAssistantText = findLastAssistantText(messages);
  const totalDurationMs = Math.max(0, child.time.updated - child.time.created);
  // 从 transcript 数真实 tool part，不用 0 兜底：投影里出现"0 次工具调用"会被读成
  // 这个 Agent 什么都没做，而实际可能做过几十次。
  const totalToolUseCount = messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.type === "tool").length,
    0,
  );

  return {
    taskId: binding.agentId,
    agentId: binding.agentId,
    agentType: binding.agentType,
    childSessionId: child.id,
    description: `Recovered agent ${binding.agentId}`,
    isBackgrounded: false,
    parentSessionId: child.parentID,
    startedAt: new Date(child.time.created),
    completedAt: new Date(child.time.updated),
    status: "completed",
    taskType: "local_agent",
    type: "local_agent",
    executionGeneration: 0,
    sessionReady: true,
    canContinue: true,
    adoptedFromStore: true,
    ...(lastAssistantText
      ? {
          output: {
            status: "completed",
            agentId: binding.agentId,
            childSessionId: child.id,
            canContinue: true,
            agentType: binding.agentType,
            description: `Recovered agent ${binding.agentId}`,
            prompt: "",
            content: [{ type: "text", text: lastAssistantText }],
            totalToolUseCount,
            totalDurationMs,
          },
        }
      : {}),
  };
}

function findLastAssistantText(messages: readonly MessageWithParts[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.info.role !== "assistant") continue;
    const text = message.parts
      .filter((part): part is TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function validateTaskOutputInput(
  input: unknown,
  context: ToolInputValidationContext,
): ToolInputValidationResult {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  return getTaskOutputInputFailure(parsed, context.runtimeTaskRegistry) ?? { result: true };
}

function getTaskOutputInputFailure(
  input: TaskOutputInput,
  registry: ToolInputValidationContext["runtimeTaskRegistry"],
): ToolHandlerFailure | undefined {
  if (!input.task_id) {
    return taskOutputFailure(TASK_OUTPUT_ERROR_CODE.TASK_ID_REQUIRED, "Task ID is required");
  }
  // 这里只做必填校验，不查 registry。"任务是否存在"由 handler 判定：live registry
  // 为空时它还会回落到 SessionStore 的持久化身份，而校验门的上下文里没有 sessionStore，
  // 在这里提前拒绝会让重启后的历史 Agent 永远查不到。handler 返回同样的错误码与文案。
  void registry;
  return undefined;
}

function formatTaskOutputModelContent(output: unknown): string {
  const parsed = TaskOutputResultSchema.parse(output);
  const blocks = [`<retrieval_status>${parsed.retrieval_status}</retrieval_status>`];
  if (parsed.waited_ms !== undefined) {
    blocks.push(`<waited_ms>${parsed.waited_ms}</waited_ms>`);
  }
  // 超时必须把「预算是多少、已用满」讲清楚：模型对时间没有概念，只收到一个 timeout
  // 标签时它既不知道等了多久，也不知道是该调大 timeout 重试还是改用 block=false 轮询。
  if (parsed.retrieval_status === "timeout") {
    blocks.push(
      `<timeout_notice>The task was still running when your wait budget ran out. To keep waiting, call TaskOutput again on the same task_id with a larger timeout (max 300000 ms). Use block=false to poll its status without waiting.</timeout_notice>`,
    );
  }
  const task = parsed.task;
  if (task) {
    blocks.push(`<task_id>${task.task_id}</task_id>`);
    blocks.push(`<task_type>${task.task_type}</task_type>`);
    blocks.push(`<status>${task.status}</status>`);
    if (task.exitCode !== undefined && task.exitCode !== null) {
      blocks.push(`<exit_code>${task.exitCode}</exit_code>`);
    }
    if (task.output.trim()) {
      // 没有真实完整文件时，task_id 不是可读取路径，不能把它伪装成
      // “Full output”；此时保留原文，由外层的大结果 artifact 机制继续处理。
      const content = (
        task.outputFile ? truncateTaskOutput(task.output, task.outputFile) : task.output
      ).trimEnd();
      blocks.push(`<output>\n${content}\n</output>`);
    }
    if (task.error) {
      blocks.push(`<error>${task.error}</error>`);
    }
  }
  return blocks.join("\n\n");
}

function truncateTaskOutput(
  output: string,
  outputPath: string,
  configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH,
): string {
  const maxLength = resolveTaskOutputLength(configuredValue);
  if (output.length <= maxLength) return output;

  const prefix = `[Truncated. Full output: ${outputPath}]\n\n`;
  const tailLength = maxLength - prefix.length;
  return prefix + output.slice(-tailLength);
}

function resolveTaskOutputLength(configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH): number {
  if (!configuredValue) return TASK_OUTPUT_DEFAULT_LENGTH;
  const parsed = Number.parseInt(configuredValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return TASK_OUTPUT_DEFAULT_LENGTH;
  return Math.min(parsed, TASK_OUTPUT_MAX_LENGTH);
}

function formatPersistedTaskOutputModelContent(input: ToolPersistedModelContentInput): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatCompactFileSize,
    originalBytes: input.content.length,
    persistedPath: input.persistedPath,
    previewChars: TASK_OUTPUT_PERSIST_PREVIEW_CHARS,
  });
}

async function waitForTask(
  taskId: string,
  timeoutMs: number,
  context: ToolExecutionContext,
): Promise<RuntimeTaskSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(context.abortSignal);
    const task = context.runtimeTaskRegistry?.get(taskId);
    if (!task) return undefined;
    if (!isTaskActive(task.status)) return task;
    await delay(TASK_OUTPUT_POLL_INTERVAL_MS);
  }
  return context.runtimeTaskRegistry?.get(taskId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const isTaskActive = (status: string): boolean => status === "running" || status === "pending";

function markTaskNotified(task: RuntimeTaskSnapshot, context: ToolExecutionContext): void {
  context.runtimeTaskRegistry?.update(task.taskId, (current) =>
    current.notified ? current : { ...current, notified: true },
  );
}

async function emitWaitingProgress(context: ToolExecutionContext): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    id: crypto.randomUUID() as never,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId as never,
      toolName: TASK_OUTPUT_TOOL_NAME,
      elapsedMs: 0,
    },
  });
}

function taskOutputResult(
  retrievalStatus: TaskOutputResult["retrieval_status"],
  task: TaskOutputTask | null,
  waited?: Pick<TaskOutputResult, "waited_ms">,
): TaskOutputResult {
  return {
    retrieval_status: retrievalStatus,
    ...(waited?.waited_ms !== undefined ? { waited_ms: waited.waited_ms } : {}),
    task,
  };
}

function requireRuntimeTaskRegistry(context: ToolExecutionContext) {
  const registry = context.runtimeTaskRegistry;
  if (registry) return registry;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    "Runtime task registry is not configured for TaskOutput",
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: TASK_OUTPUT_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}
