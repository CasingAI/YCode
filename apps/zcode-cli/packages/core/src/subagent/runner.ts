/* eslint-disable max-lines -- subagent runner 集中维护前台/后台生命周期、registry 与 notification 顺序，拆分前需要先稳定生命周期边界。 */
// ============================================================
// Subagent Runner
// ============================================================

import {
  AgentErrorCode,
  CoreErrorType,
  DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createSessionEvent,
  createSessionId,
  createTraceId,
  getModelUsageTotalTokens,
  hasModelUsage,
  isCoreError,
  traceContextToLogContext,
  type AgentBackgroundedOutput,
  type BackgroundResultOriginMeta,
  type AgentCompletedOutput,
  type AgentTerminalOutput,
  type AgentOutput,
  type Logger,
  type ModelUsage,
  type SessionEvent,
  type SessionId,
  type SubagentLaunchOptions,
  type SubagentLaunchRequest,
  type SubagentPort,
  type SubagentRunOptions,
  type SubagentRunRequest,
  type SubagentSendMessageOptions,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
  type SubagentStartOptions,
  type SubagentStartRequest,
  type SubagentStopOptions,
  type SubagentTaskSnapshot,
  type SubagentWaitOptions,
  type TraceContext,
} from "@zcode/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isBuiltInExploreAgentProfile,
  normalizeAgentProfiles,
  type AgentProfile,
} from "./profile.js";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "./explore-tools.js";
import { formatLocalAgentTaskNotification } from "./completion-notification.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import {
  InMemoryRuntimeTaskRegistry,
  isTerminalRuntimeTask,
  type RuntimeTaskMessageSink,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";

export interface ExploreSubagentRuntimeRequest {
  agentId: string;
  agentType: string;
  allowedTools: readonly string[];
  /** 每次读取都返回 runtime task registry 的当前状态；新 Agent 始终为 foreground。 */
  background: boolean;
  disallowedTools?: readonly string[];
  sessionId: SessionId;
  description: string;
  maxTurns?: number;
  /** child session 已持久化且可被 projection/query 读取后、首次模型执行前调用。 */
  onSessionReady?: () => Promise<void>;
  permissionMode?: AgentProfile["permissionMode"];
  prompt: string;
  profile: AgentProfile;
  registerMessageSink?: (sink: RuntimeTaskMessageSink) => void;
  reportActivity?: () => void;
  resumeFromStore?: boolean;
  systemPrompt?: string;
  workingDirectory: string;
  workspaceRoot: string;
  traceContext: TraceContext;
}

export interface ExploreSubagentRuntimeResult {
  response: string;
  traceId: TraceContext["traceId"];
  events: SessionEvent[];
}

export interface ParentTaskNotificationCommand {
  originMeta: BackgroundResultOriginMeta;
  text: string;
  traceContext: TraceContext;
  taskId: string;
}

export type EnqueueParentTaskNotification = (
  notification: ParentTaskNotificationCommand,
) => undefined;

/** 失败/取消终态从子会话事件回读到的用量；字段缺失表示无法证明，而非 0。 */
interface SubagentRecoveredUsage {
  toolUseCount: number;
  reasoningDurationMs?: number;
}

export interface ExploreSubagentPortOptions {
  runExploreAgent: (
    request: ExploreSubagentRuntimeRequest,
    options?: SubagentRunOptions,
  ) => Promise<ExploreSubagentRuntimeResult>;
  emitParentEvent: (event: SessionEvent, traceContext: TraceContext) => Promise<void>;
  /**
   * 读取子会话已落库事件。失败/取消终态没有 TurnResult，
   * 只能从这里取回终态前真实发生的工具与思考，避免把已做的工作记成 0。
   */
  readChildSessionEvents?: (childSessionId: SessionId) => Promise<SessionEvent[]>;
  // 仅供旧后台 Agent 任务收尾时同步写入父 runtime command queue。
  enqueueParentTaskNotification?: EnqueueParentTaskNotification;
  outputRootDir?: string;
  profiles?: readonly AgentProfile[];
  builtInModelSelectionOverrides?: Partial<
    Record<"general-purpose" | "Explore", import("@zcode/shared").ModelSelection>
  >;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  createAgentId?: () => string;
  getAllowedTools?: (profile: AgentProfile) => readonly string[];
  inactivityTimeoutMs?: number;
  /** @deprecated 普通 Agent 始终前台执行；该字段仅为旧注入配置兼容保留。 */
  autoBackgroundMs?: number;
  logger?: Logger;
}

export function createExploreSubagentPort(options: ExploreSubagentPortOptions): SubagentPort {
  const registry = options.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
  const abortControllers = new Map<string, AbortController>();
  const profiles = normalizeAgentProfiles(options.profiles ?? [], {
    builtInModelSelectionOverrides: options.builtInModelSelectionOverrides,
  });
  const port: SubagentPort & { start: NonNullable<SubagentPort["start"]> } = {
    async launch(
      rawRequest: SubagentLaunchRequest,
      launchOptions?: SubagentLaunchOptions,
    ): Promise<AgentOutput> {
      if (rawRequest.runInBackground === true) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "Background execution is not supported for Agent subagents. Run it in the foreground.",
          {
            context: {
              code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
              agentType: rawRequest.agentType,
              parentToolCallId: rawRequest.parentToolCallId,
            },
            recoverable: true,
          },
        );
      }
      return port.run(toSubagentExecutionRequest(rawRequest), launchOptions);
    },

    async run(
      rawRequest: SubagentRunRequest,
      runOptions?: SubagentRunOptions,
    ): Promise<AgentOutput> {
      const { profile, request } = resolveAgentProfileForRequest(profiles, rawRequest);
      const lifecycle = createSubagentLifecycle(options, request, profile);
      const startedAt = new Date(lifecycle.startedAt);

      registry.register(
        createRuntimeTaskSnapshot({
          isBackgrounded: false,
          lifecycle,
          request,
          startedAt,
          status: "running",
        }),
      );
      try {
        await writeAgentMetadataFile(lifecycle, request, "running");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const terminal = createTerminalOutput({
          status: "failed",
          lifecycle,
          request,
          errorMessage,
          totalDurationMs: Date.now() - lifecycle.startedAt,
          canContinue: true,
          contextReset: true,
        });
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: terminal.status,
          completedAt: new Date(),
          error: errorMessage,
          output: terminal,
          canContinue: true,
        }));
        return terminal;
      }

      const taskAbort = createSubagentTaskAbortController(
        abortControllers,
        lifecycle.agentId,
        runOptions?.signal,
      );
      const activityWatchdog = createSubagentActivityWatchdog({
        abort: taskAbort.abort,
        lifecycle,
        logger: options.logger,
        request,
        signal: taskAbort.signal,
        timeoutMs: options.inactivityTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
      });
      const readyGate = createSubagentSessionReadyGate();
      // child persistence/resume 可能在 onSessionReady 前永久挂起；watchdog 和
      // abort guard 必须覆盖完整 setup，而不能把 Ready 当成取消能力的安装边界。
      activityWatchdog.start();
      const completionPromise = runAgentToCompletion(
        options,
        request,
        lifecycle,
        registry,
        {
          signal: taskAbort.signal,
          ...(runOptions?.model ? { model: runOptions.model } : {}),
          ...(runOptions?.modelOverride ? { modelOverride: runOptions.modelOverride } : {}),
        },
        {
          reportActivity: activityWatchdog.reportActivity,
        },
        {
          onSessionReady: async () => {
            registry.update(lifecycle.agentId, (task) => ({
              ...task,
              sessionReady: true,
              canContinue: true,
            }));
            await emitSubagentEvent(
              options,
              SessionEventType.SubagentSpawned,
              request,
              lifecycle.runTraceContext,
              {
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                childSessionId: lifecycle.childSessionId,
                description: request.description,
                prompt: request.prompt,
                parentToolCallId: request.parentToolCallId,
                status: "running",
                allowedTools: [...resolveAllowedTools(profile, options)],
                model: profile.modelSelection
                  ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
                  : undefined,
              },
            );
            readyGate.resolve();
          },
        },
      );
      void completionPromise.catch((error: unknown) => readyGate.reject(error));
      try {
        await guardSubagentPromiseWithAbort(
          readyGate.promise,
          request,
          lifecycle,
          taskAbort.signal,
        );
      } catch (error) {
        activityWatchdog.stop();
        taskAbort.abort(error);
        taskAbort.dispose();
        const errorMessage = error instanceof Error ? error.message : String(error);
        const recoveredUsage = await recoverSubagentUsage(options, lifecycle.childSessionId);
        const terminal = createTerminalOutput({
          status:
            runOptions?.signal?.aborted === true ||
            (isCoreError(error) && error.type === CoreErrorType.ToolCancelled)
              ? "cancelled"
              : "failed",
          lifecycle,
          request,
          errorMessage,
          totalDurationMs: Date.now() - lifecycle.startedAt,
          canContinue: true,
          contextReset: true,
          recoveredUsage,
        });
        await writeTerminalAgentArtifacts(lifecycle, request, terminal, errorMessage);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: terminal.status,
          completedAt: new Date(),
          error: errorMessage,
          output: terminal,
          canContinue: true,
        }));
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: terminal.status,
            totalDurationMs: terminal.totalDurationMs,
            ...(recoveredUsage ? { totalToolUseCount: recoveredUsage.toolUseCount } : {}),
            ...(recoveredUsage?.reasoningDurationMs === undefined
              ? {}
              : { totalReasoningDurationMs: recoveredUsage.reasoningDurationMs }),
            error: errorMessage,
          },
        );
        return terminal;
      }

      options.logger?.info("Explore subagent spawned", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        event: "subagent.spawned",
        module: "core.subagent",
        parentToolCallId: request.parentToolCallId,
        status: "started",
      });
      const guardedCompletionPromise = guardSubagentPromiseWithAbort(
        completionPromise,
        request,
        lifecycle,
        taskAbort.signal,
      );

      try {
        const completed = await guardedCompletionPromise;
        activityWatchdog.stop();
        taskAbort.dispose();

        await writeCompletedAgentArtifacts(lifecycle, request, completed.output);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: "completed",
          sessionReady: true,
          canContinue: true,
          completedAt: new Date(),
          output: completed.output,
          usage: {
            durationMs: completed.output.totalDurationMs,
            modelUsage: completed.output.usage,
            toolUseCount: completed.output.totalToolUseCount,
            totalTokens: completed.output.totalTokens,
          },
        }));

        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: "completed",
            totalDurationMs: completed.output.totalDurationMs,
            totalToolUseCount: completed.output.totalToolUseCount,
            ...(completed.output.totalReasoningDurationMs === undefined
              ? {}
              : { totalReasoningDurationMs: completed.output.totalReasoningDurationMs }),
            totalTokens: completed.output.totalTokens,
          },
        );

        options.logger?.info("Explore subagent completed", {
          ...traceContextToLogContext(lifecycle.runTraceContext),
          agentId: lifecycle.agentId,
          durationMs: completed.output.totalDurationMs,
          event: "subagent.completed",
          module: "core.subagent",
          status: "completed",
          totalToolUseCount: completed.output.totalToolUseCount,
          totalTokens: completed.output.totalTokens,
        });

        return completed.output;
      } catch (error) {
        activityWatchdog.stop();
        taskAbort.dispose();
        const totalDurationMs = Date.now() - lifecycle.startedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const cancelled =
          runOptions?.signal?.aborted === true ||
          (isCoreError(error) && error.type === CoreErrorType.ToolCancelled);
        const recoveredUsage = await recoverSubagentUsage(options, lifecycle.childSessionId);
        const terminalOutput = createTerminalOutput({
          status: cancelled ? "cancelled" : "failed",
          lifecycle,
          request,
          errorMessage,
          totalDurationMs,
          canContinue: true,
          contextReset: registry.get(lifecycle.agentId)?.sessionReady !== true,
          recoveredUsage,
        });
        await writeTerminalAgentArtifacts(lifecycle, request, terminalOutput, errorMessage);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: terminalOutput.status,
          sessionReady: task.sessionReady === true,
          canContinue: terminalOutput.canContinue === true,
          completedAt: new Date(),
          error: errorMessage,
          output: terminalOutput,
          usage: {
            durationMs: totalDurationMs,
            ...(recoveredUsage ? { toolUseCount: recoveredUsage.toolUseCount } : {}),
          },
        }));
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: terminalOutput.status,
            totalDurationMs,
            ...(recoveredUsage ? { totalToolUseCount: recoveredUsage.toolUseCount } : {}),
            ...(recoveredUsage?.reasoningDurationMs === undefined
              ? {}
              : { totalReasoningDurationMs: recoveredUsage.reasoningDurationMs }),
            error: errorMessage,
          },
        );
        return terminalOutput;
      } finally {
        activityWatchdog.stop();
      }
    },

    async start(
      _rawRequest: SubagentStartRequest,
      _startOptions?: SubagentStartOptions,
    ): Promise<AgentBackgroundedOutput> {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Background execution is not supported for Agent subagents. Run it in the foreground.",
        {
          context: { code: AgentErrorCode.BACKGROUND_UNAVAILABLE },
          recoverable: true,
        },
      );
    },

    async getTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      return registry.get(taskId);
    },

    async backgroundTask(_taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Foreground Agent subagents cannot be moved to the background.",
        {
          context: { code: AgentErrorCode.BACKGROUND_UNAVAILABLE },
          recoverable: true,
        },
      );
    },

    async waitForTask(
      taskId: string,
      waitOptions?: SubagentWaitOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      return registry.waitForTerminal(taskId, { signal: waitOptions?.signal });
    },

    async stopTask(
      taskId: string,
      stopOptions?: SubagentStopOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      if (stopOptions?.signal?.aborted) {
        throw stopOptions.signal.reason ?? new Error("Subagent stop aborted");
      }
      const task = registry.get(taskId);
      if (!task || task.type !== "local_agent") return task;
      if (isTerminalRuntimeTask(task)) return task;
      // 前台 child 的终态由 run() 统一写入；这里不能调用旧后台停止器，否则会重复发
      // BackgroundTaskCompleted/SubagentStopped 并覆盖前台结果，也不能把 running 伪装成停止成功。
      if (!task.isBackgrounded) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "Foreground Agent subagents cannot be stopped as background tasks. Cancel the parent turn instead.",
          {
            context: {
              code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
              agentId: task.agentId,
              agentType: task.agentType,
            },
            recoverable: true,
          },
        );
      }

      const stopped = createBackgroundStoppedTask(registry, task);
      if (!stopped) return undefined;
      return finalizeBackgroundStopped(options, registry, stopped, () => {
        abortControllers
          .get(taskId)
          ?.abort(new Error(`${BACKGROUND_AGENT_STOPPED_STATE.message}: ${taskId}`));
        abortControllers.delete(taskId);
      });
    },

    async sendMessage(
      request: SubagentSendMessageRequest,
      sendOptions?: SubagentSendMessageOptions,
    ): Promise<SubagentSendMessageResult> {
      return sendMessageToLocalAgent(
        options,
        profiles,
        registry,
        abortControllers,
        request,
        sendOptions,
      );
    },
  };

  return port;
}

interface SubagentLifecycle {
  agentId: string;
  childSessionId: SessionId;
  metadataFile: string;
  outputFile: string;
  taskOutputFile: string;
  profile: AgentProfile;
  startedAt: number;
  runTraceContext: TraceContext;
  childTraceContext: TraceContext;
}

type AgentProfileResolution =
  | { kind: "matched"; profile: AgentProfile }
  | { availableAgentTypes: readonly string[]; kind: "not_found" }
  | {
      availableAgentTypes: readonly string[];
      kind: "ambiguous";
      matches: readonly string[];
    };

interface SubagentTaskAbortHandle {
  abort(reason?: unknown): void;
  dispose(): void;
  signal: AbortSignal;
}

function createSubagentTaskAbortController(
  abortControllers: Map<string, AbortController>,
  agentId: string,
  parentSignal?: AbortSignal,
): SubagentTaskAbortHandle {
  const controller = new AbortController();
  abortControllers.set(agentId, controller);
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? new Error(`Subagent task aborted: ${agentId}`));
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const dispose = (): void => {
    parentSignal?.removeEventListener("abort", onParentAbort);
    if (abortControllers.get(agentId) === controller) {
      abortControllers.delete(agentId);
    }
  };

  return {
    abort: (reason?: unknown) => controller.abort(reason),
    dispose,
    signal: controller.signal,
  };
}

function resolveAgentProfileForRequest(
  profiles: readonly AgentProfile[],
  request: SubagentRunRequest,
): { profile: AgentProfile; request: SubagentRunRequest } {
  const resolution = resolveAgentProfileByType(profiles, request.agentType);
  if (resolution.kind === "matched") {
    const { profile } = resolution;
    return {
      profile,
      request:
        profile.name === request.agentType
          ? request
          : {
              ...request,
              // 模型可能按大小写/分隔符近似写 subagent_type；后续
              // toolset、事件和 metadata 都依赖 canonical agentType，必须在入口统一收敛。
              agentType: profile.name,
            },
    };
  }

  if (resolution.kind === "ambiguous") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      [
        `Agent type '${request.agentType}' is ambiguous`,
        `matches ${resolution.matches.join(", ")}`,
        `Use the exact name: ${resolution.matches.join(" or ")}`,
      ].join(" — "),
      {
        context: {
          code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
          agentType: request.agentType,
          matches: resolution.matches,
          parentToolCallId: request.parentToolCallId,
        },
        recoverable: true,
      },
    );
  }

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Agent type '${request.agentType}' not found. Available agents: ${resolution.availableAgentTypes.join(", ")}`,
    {
      context: {
        code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
        agentType: request.agentType,
        availableAgentTypes: resolution.availableAgentTypes,
        parentToolCallId: request.parentToolCallId,
      },
      recoverable: true,
    },
  );
}

function resolveAgentProfileByType(
  profiles: readonly AgentProfile[],
  requestedAgentType: string,
): AgentProfileResolution {
  const exact = profiles.find((candidate) => candidate.name === requestedAgentType);
  if (exact) return { kind: "matched", profile: exact };

  const availableAgentTypes = profiles.map((profile) => profile.name);

  const requestedNormalized = normalizeAgentTypeForMatch(requestedAgentType);
  if (!requestedNormalized) return { availableAgentTypes, kind: "not_found" };

  const normalizedMatches = profiles.filter(
    (candidate) => normalizeAgentTypeForMatch(candidate.name) === requestedNormalized,
  );
  if (normalizedMatches.length === 1) {
    return { kind: "matched", profile: normalizedMatches[0] };
  }
  if (normalizedMatches.length > 1) {
    return {
      availableAgentTypes,
      kind: "ambiguous",
      matches: normalizedMatches.map((profile) => profile.name),
    };
  }

  return { availableAgentTypes, kind: "not_found" };
}

function normalizeAgentTypeForMatch(agentType: string): string | undefined {
  const normalized = agentType
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return normalized.length > 0 ? normalized : undefined;
}

function toSubagentExecutionRequest(request: SubagentLaunchRequest): SubagentRunRequest {
  const { runInBackground: _runInBackground, ...executionRequest } = request;
  return executionRequest;
}

function createSubagentLifecycle(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
): SubagentLifecycle {
  const agentId = options.createAgentId?.() ?? `agent_${crypto.randomUUID()}`;
  const childSessionId = createSessionId(`subagent_${agentId}`);
  const startedAt = Date.now();
  const agentOutputDir = join(
    options.outputRootDir ?? join(tmpdir(), "zcode-agents"),
    request.sessionId,
    agentId,
  );
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

function createContinuationLifecycle(
  task: RuntimeTaskSnapshot,
  request: SubagentSendMessageRequest,
  profile: AgentProfile,
): SubagentLifecycle {
  const childSessionId = task.childSessionId ?? createSessionId(`subagent_${task.agentId}`);
  const startedAt = Date.now();
  const outputFile =
    task.outputFile ??
    join(tmpdir(), "zcode-agents", request.sessionId, task.agentId, "output.txt");
  const outputDir = dirname(outputFile);
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId: task.agentId,
      agentType: task.agentType,
      parentToolCallId: request.parentToolCallId,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    turnId: request.turnId,
    attributes: {
      agentId: task.agentId,
      agentType: task.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
    },
  });
  return {
    agentId: task.agentId,
    childSessionId,
    metadataFile: join(outputDir, "metadata.json"),
    outputFile,
    taskOutputFile: join(outputDir, "task.output"),
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

function sameAgentWorkspace(
  task: Pick<RuntimeTaskSnapshot, "workspaceIdentity" | "workspaceRoot">,
  request: Pick<SubagentSendMessageRequest, "workspaceIdentity" | "workspaceRoot">,
): boolean {
  const expected = request.workspaceIdentity?.trim() || request.workspaceRoot?.trim();
  const actual = task.workspaceIdentity?.trim() || task.workspaceRoot?.trim();
  return !actual || !expected || actual === expected;
}

async function sendMessageToLocalAgent(
  options: ExploreSubagentPortOptions,
  profiles: readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  abortControllers: Map<string, AbortController>,
  request: SubagentSendMessageRequest,
  sendOptions?: SubagentSendMessageOptions,
): Promise<SubagentSendMessageResult> {
  if (sendOptions?.signal?.aborted) {
    return createSendMessageFailure(request, `SendMessage was aborted for ${request.to}.`);
  }
  const task = registry.get(request.to);
  if (!task || task.type !== "local_agent") {
    return createSendMessageFailure(request, `No local agent found for target ${request.to}.`);
  }
  const message = createRuntimeTaskPendingMessage(request);
  if (!isTerminalRuntimeTask(task)) {
    return deliverMessageToRunningAgent(registry, task, message);
  }
  if (request.sessionId && task.parentSessionId && task.parentSessionId !== request.sessionId) {
    return createSendMessageFailure(
      request,
      `Agent ${task.agentId} belongs to another parent session.`,
    );
  }
  if (!sameAgentWorkspace(task, request)) {
    return createSendMessageFailure(request, `Agent ${task.agentId} belongs to another workspace.`);
  }

  const profile =
    task.profileSnapshot ??
    resolveAgentProfileForRequest(profiles, {
      sessionId: request.sessionId,
      turnId: request.turnId,
      parentToolCallId: request.parentToolCallId,
      agentType: task.agentType,
      description: task.description,
      prompt: request.message,
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      trace: request.trace,
    }).profile;
  const continuationId = `send:${String(request.parentToolCallId)}`;
  const resumeFromStore = task.sessionReady === true;
  const claimed = registry.compareAndSwap(task.taskId, (current) => {
    if (!isTerminalRuntimeTask(current)) return undefined;
    if (
      request.sessionId &&
      current.parentSessionId &&
      current.parentSessionId !== request.sessionId
    ) {
      return undefined;
    }
    if (!sameAgentWorkspace(current, request)) return undefined;
    return {
      ...withoutRuntimeMessageState(current),
      status: "running",
      executionGeneration: (current.executionGeneration ?? 0) + 1,
      continuationId,
      sessionReady: false,
      canContinue: false,
      completedAt: undefined,
      error: undefined,
      output: undefined,
    };
  });
  if (!claimed) {
    const current = registry.get(task.taskId);
    if (current?.status === "running") {
      return deliverMessageToRunningAgent(registry, current, message);
    }
    if (
      current?.continuationId === continuationId &&
      current.output &&
      current.output.status !== "async_launched"
    ) {
      return {
        status: "success",
        messageId: message.id,
        delivery: "resumed_foreground",
        agentId: current.agentId,
        taskId: current.taskId,
        outputFile: current.outputFile,
        continuation: current.output,
        message: `Agent ${current.agentId} continuation already completed.`,
      };
    }
    return createSendMessageFailure(
      request,
      `Agent ${task.agentId} could not be claimed for continuation.`,
    );
  }
  return resumeTerminalAgentForeground({
    options,
    registry,
    abortControllers,
    task: claimed,
    request,
    message,
    profile,
    sendOptions,
    resumeFromStore,
  });
}

async function resumeTerminalAgentForeground(input: {
  options: ExploreSubagentPortOptions;
  registry: RuntimeTaskRegistry;
  abortControllers: Map<string, AbortController>;
  task: RuntimeTaskSnapshot;
  request: SubagentSendMessageRequest;
  message: RuntimeTaskPendingMessage;
  profile: AgentProfile;
  sendOptions?: SubagentSendMessageOptions;
  resumeFromStore: boolean;
}): Promise<SubagentSendMessageResult> {
  const { options, registry, request, task, profile } = input;
  const continuationRequest: SubagentRunRequest = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    parentToolCallId: request.parentToolCallId,
    agentType: task.agentType,
    description: task.description,
    prompt: request.message,
    workspaceIdentity: request.workspaceIdentity,
    workingDirectory: request.workingDirectory,
    workspaceRoot: request.workspaceRoot,
    trace: request.trace,
  };
  const lifecycle = createContinuationLifecycle(task, request, profile);
  const generation = input.task.executionGeneration ?? 1;
  const taskAbort = createSubagentTaskAbortController(
    input.abortControllers,
    task.agentId,
    input.sendOptions?.signal,
  );
  const watchdog = createSubagentActivityWatchdog({
    abort: taskAbort.abort,
    lifecycle,
    logger: options.logger,
    request: continuationRequest,
    signal: taskAbort.signal,
    timeoutMs: options.inactivityTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  });
  watchdog.start();
  try {
    const completion = runAgentToCompletion(
      options,
      continuationRequest,
      lifecycle,
      registry,
      {
        signal: taskAbort.signal,
        ...(input.sendOptions?.model ? { model: input.sendOptions.model } : {}),
        ...(input.sendOptions?.modelOverride
          ? { modelOverride: input.sendOptions.modelOverride }
          : {}),
      },
      { reportActivity: watchdog.reportActivity },
      {
        resumeFromStore: input.resumeFromStore,
        onSessionReady: async () => {
          registry.compareAndSwap(task.agentId, (current) =>
            current.executionGeneration === generation
              ? { ...current, sessionReady: true, canContinue: true }
              : undefined,
          );
          await emitSubagentEvent(
            options,
            SessionEventType.SubagentSpawned,
            continuationRequest,
            lifecycle.runTraceContext,
            {
              agentId: lifecycle.agentId,
              agentType: task.agentType,
              childSessionId: lifecycle.childSessionId,
              description: task.description,
              prompt: request.message,
              parentToolCallId: request.parentToolCallId,
              status: "running",
              resumed: true,
              background: false,
            },
          );
        },
      },
    );
    const completed = await guardSubagentPromiseWithAbort(
      completion,
      continuationRequest,
      lifecycle,
      taskAbort.signal,
    );
    watchdog.stop();
    taskAbort.dispose();
    await writeCompletedAgentArtifacts(lifecycle, continuationRequest, completed.output);
    registry.compareAndSwap(task.agentId, (current) =>
      current.executionGeneration === generation
        ? {
            ...withoutRuntimeMessageState(current),
            status: "completed",
            sessionReady: true,
            canContinue: true,
            completedAt: new Date(),
            output: completed.output,
            usage: {
              durationMs: completed.output.totalDurationMs,
              modelUsage: completed.output.usage,
              toolUseCount: completed.output.totalToolUseCount,
              totalTokens: completed.output.totalTokens,
            },
          }
        : undefined,
    );
    await emitSubagentEvent(
      options,
      SessionEventType.SubagentStopped,
      continuationRequest,
      lifecycle.runTraceContext,
      {
        agentId: lifecycle.agentId,
        agentType: task.agentType,
        childSessionId: lifecycle.childSessionId,
        parentToolCallId: request.parentToolCallId,
        status: "completed",
        resumed: true,
        background: false,
        totalDurationMs: completed.output.totalDurationMs,
        totalToolUseCount: completed.output.totalToolUseCount,
        ...(completed.output.totalReasoningDurationMs === undefined
          ? {}
          : { totalReasoningDurationMs: completed.output.totalReasoningDurationMs }),
      },
    );
    return {
      status: "success",
      messageId: input.message.id,
      delivery: "resumed_foreground",
      agentId: task.agentId,
      taskId: task.taskId,
      outputFile: task.outputFile,
      continuation: completed.output,
      message: `Agent ${task.agentId} continued and completed.`,
    };
  } catch (error) {
    watchdog.stop();
    taskAbort.dispose();
    const cancelled =
      input.sendOptions?.signal?.aborted === true ||
      (isCoreError(error) && error.type === CoreErrorType.ToolCancelled);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const recoveredUsage = await recoverSubagentUsage(options, lifecycle.childSessionId);
    const terminal = createTerminalOutput({
      status: cancelled ? "cancelled" : "failed",
      lifecycle,
      request: continuationRequest,
      errorMessage,
      totalDurationMs: Date.now() - lifecycle.startedAt,
      canContinue: true,
      contextReset: registry.get(task.agentId)?.sessionReady !== true,
      recoveredUsage,
    });
    await writeTerminalAgentArtifacts(lifecycle, continuationRequest, terminal, errorMessage);
    registry.compareAndSwap(task.agentId, (current) =>
      current.executionGeneration === generation
        ? {
            ...withoutRuntimeMessageState(current),
            status: terminal.status,
            completedAt: new Date(),
            error: errorMessage,
            output: terminal,
            canContinue: terminal.canContinue === true,
          }
        : undefined,
    );
    await emitSubagentEvent(
      options,
      SessionEventType.SubagentStopped,
      continuationRequest,
      lifecycle.runTraceContext,
      {
        agentId: task.agentId,
        agentType: task.agentType,
        childSessionId: lifecycle.childSessionId,
        parentToolCallId: request.parentToolCallId,
        status: terminal.status,
        resumed: true,
        background: false,
        totalDurationMs: terminal.totalDurationMs,
        ...(recoveredUsage ? { totalToolUseCount: recoveredUsage.toolUseCount } : {}),
        ...(recoveredUsage?.reasoningDurationMs === undefined
          ? {}
          : { totalReasoningDurationMs: recoveredUsage.reasoningDurationMs }),
        error: errorMessage,
      },
    );
    return {
      status: "success",
      messageId: input.message.id,
      delivery: "resumed_foreground",
      agentId: task.agentId,
      taskId: task.taskId,
      outputFile: task.outputFile,
      continuation: terminal,
      message: `Agent ${task.agentId} continuation ended with status ${terminal.status}.`,
    };
  } finally {
    watchdog.stop();
  }
}
async function deliverMessageToRunningAgent(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  message: RuntimeTaskPendingMessage,
): Promise<SubagentSendMessageResult> {
  if (task.messageSink) {
    try {
      const delivery = await task.messageSink.send(message);
      return createSendMessageSuccess(task, message, delivery);
    } catch {
      registry.queueMessage(task.taskId, message);
      return createSendMessageSuccess(task, message, "queued");
    }
  }

  registry.queueMessage(task.taskId, message);
  return createSendMessageSuccess(task, message, "queued");
}

function createRuntimeTaskPendingMessage(
  request: SubagentSendMessageRequest,
): RuntimeTaskPendingMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    isMeta: true,
    message: request.message,
    origin: {
      kind: "coordinator",
      toolCallId: String(request.parentToolCallId),
    },
    queuedAt: new Date(),
    summary: request.summary,
    traceContext: request.trace,
  };
}

function createSendMessageSuccess(
  task: Pick<RuntimeTaskSnapshot, "agentId" | "outputFile" | "status" | "taskId">,
  message: RuntimeTaskPendingMessage,
  delivery: NonNullable<SubagentSendMessageResult["delivery"]>,
): SubagentSendMessageResult {
  const providerMessage =
    delivery === "queued"
      ? `Message queued for delivery to ${task.agentId} at its next tool round.`
      : delivery === "resumed_background"
        ? `Agent "${task.agentId}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`
        : `Message ${message.id} was sent to its active turn for local agent ${task.agentId}.`;
  return {
    status: "success",
    messageId: message.id,
    delivery,
    agentId: task.agentId,
    taskId: task.taskId,
    outputFile: task.outputFile,
    message: providerMessage,
  };
}

function createSendMessageFailure(
  request: SubagentSendMessageRequest,
  error: string,
): SubagentSendMessageResult {
  return {
    status: "failed",
    messageId: `msg_${crypto.randomUUID()}`,
    agentId: request.to,
    error,
    message: error,
  };
}

async function runAgentToCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  monitorOptions: { reportActivity?: () => void } = {},
  executionOptions: SubagentExecutionOptions = {},
): Promise<{ events: SessionEvent[]; output: AgentCompletedOutput }> {
  let sessionReady = false;
  const notifySessionReady = async () => {
    if (sessionReady) return;
    await executionOptions.onSessionReady?.();
    sessionReady = true;
  };
  const childResult = await options.runExploreAgent(
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      allowedTools: resolveAllowedTools(lifecycle.profile, options),
      // 读取 registry 的实时状态，兼容旧任务投影；新 Agent 在整个前台生命周期内均为 false。
      get background() {
        return registry.get(lifecycle.agentId)?.isBackgrounded === true;
      },
      disallowedTools: lifecycle.profile.disallowedTools,
      sessionId: lifecycle.childSessionId,
      description: request.description,
      maxTurns: lifecycle.profile.maxTurns,
      onSessionReady: notifySessionReady,
      permissionMode: lifecycle.profile.permissionMode,
      prompt: request.prompt,
      profile: lifecycle.profile,
      registerMessageSink: createMessageSinkRegistration(options, lifecycle, registry),
      reportActivity: monitorOptions.reportActivity,
      resumeFromStore: executionOptions.resumeFromStore,
      systemPrompt: lifecycle.profile.systemPrompt,
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      traceContext: lifecycle.childTraceContext,
    },
    runOptions,
  );
  // 测试桩和旧注入实现可能尚未主动调用 readiness hook；真实 AgentRuntime 会在
  // persist 后调用。回落只保证兼容，不改变生产链路的 persist-before-spawn 顺序。
  await notifySessionReady();

  const usage = aggregateModelUsage(childResult.events);
  const totalTokens = usage?.totalTokens;
  const totalToolUseCount = resolveSubagentToolUseCount(childResult.events);
  const totalReasoningDurationMs = resolveSubagentReasoningDurationMs(childResult.events);
  const totalDurationMs = Date.now() - lifecycle.startedAt;

  const output: AgentCompletedOutput = {
    status: "completed",
    agentId: lifecycle.agentId,
    childSessionId: lifecycle.childSessionId,
    canContinue: true,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    content: [
      {
        type: "text",
        text: childResult.response,
      },
    ],
    totalToolUseCount,
    ...(totalReasoningDurationMs === undefined ? {} : { totalReasoningDurationMs }),
    totalDurationMs,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usage === undefined ? {} : { usage }),
  };

  return { events: childResult.events, output };
}

function createSubagentActivityWatchdog(options: {
  abort: (reason?: unknown) => void;
  lifecycle: SubagentLifecycle;
  logger?: Logger;
  request: SubagentRunRequest;
  signal: AbortSignal;
  timeoutMs: number;
}): {
  reportActivity: () => void;
  start: () => void;
  stop: () => void;
} {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      reportActivity: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    stop();
    if (options.signal.aborted) return;
    timer = setTimeout(() => {
      const idleMs = Date.now() - lastActivityAt;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Subagent was inactive for ${options.timeoutMs}ms`,
        {
          context: {
            code: AgentErrorCode.CHILD_RUNTIME_FAILED,
            agentId: options.lifecycle.agentId,
            agentType: options.request.agentType,
            idleMs,
            parentToolCallId: options.request.parentToolCallId,
            timeoutMs: options.timeoutMs,
          },
          recoverable: true,
          retryable: true,
        },
      );
      options.logger?.warn("Explore subagent activity watchdog fired", {
        ...traceContextToLogContext(options.lifecycle.runTraceContext),
        agentId: options.lifecycle.agentId,
        agentType: options.request.agentType,
        event: "subagent.activity_timeout",
        idleMs,
        module: "core.subagent",
        parentToolCallId: options.request.parentToolCallId,
        status: "failed",
        timeoutMs: options.timeoutMs,
      });
      options.abort(error);
    }, options.timeoutMs);
  };

  const reportActivity = () => {
    lastActivityAt = Date.now();
    schedule();
  };

  return {
    reportActivity,
    start: reportActivity,
    stop,
  };
}

function guardSubagentPromiseWithAbort<T>(
  promise: Promise<T>,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;

  // abort 只记录父工具要返回的终态，不能抢先结束 join；否则 child 仍可能在
  // runtime 清理期间运行，而父 turn 已被标记完成。child settle 后再按取消原因拒绝。
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortHandler);
      callback();
    };

    const abortError = (): unknown => {
      if (isCoreError(signal?.reason)) return signal.reason;
      return createCoreError(
        CoreErrorType.ToolCancelled,
        "Agent was cancelled before the subagent returned its findings",
        {
          cause: signal?.reason instanceof Error ? signal.reason : undefined,
          context: {
            code: AgentErrorCode.CHILD_RUNTIME_FAILED,
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            parentToolCallId: request.parentToolCallId,
          },
          recoverable: true,
        },
      );
    };

    const abortHandler = () => {
      aborted = true;
    };

    promise.then(
      (completed) => settle(() => (aborted ? reject(abortError()) : resolve(completed))),
      (error: unknown) => settle(() => reject(aborted ? abortError() : error)),
    );

    if (signal.aborted) {
      abortHandler();
      return;
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

interface SubagentExecutionOptions {
  resumeFromStore?: boolean;
  onSessionReady?: () => Promise<void>;
  onSessionStartFailed?: (error: unknown) => void;
}

function createSubagentSessionReadyGate(): {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let settled = false;
  return {
    promise,
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

function createMessageSinkRegistration(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
): (sink: RuntimeTaskMessageSink) => void {
  return (sink) => {
    registry.update(lifecycle.agentId, (task) => ({
      ...task,
      messageSink: sink,
    }));
    void flushPendingMessages(options, lifecycle, registry, sink);
  };
}

async function flushPendingMessages(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  sink: RuntimeTaskMessageSink,
): Promise<void> {
  const pending = registry.drainMessages(lifecycle.agentId);
  for (let index = 0; index < pending.length; index++) {
    const message = pending[index];
    if (!message) continue;
    try {
      await sink.send(message);
    } catch (error) {
      for (const undelivered of pending.slice(index)) {
        registry.queueMessage(lifecycle.agentId, undelivered);
      }
      options.logger?.warn("Failed to flush pending subagent message", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.message.flush.failed",
        module: "core.subagent",
        status: "failed",
      });
      return;
    }
  }
}

function createRuntimeTaskSnapshot(input: {
  isBackgrounded: boolean;
  lifecycle: SubagentLifecycle;
  request: SubagentRunRequest;
  startedAt: Date;
  status: RuntimeTaskSnapshot["status"];
}): RuntimeTaskSnapshot {
  return {
    taskId: input.lifecycle.agentId,
    agentId: input.lifecycle.agentId,
    agentType: input.request.agentType,
    childSessionId: input.lifecycle.childSessionId,
    description: input.request.description,
    isBackgrounded: input.isBackgrounded,
    outputFile: input.lifecycle.outputFile,
    parentToolCallId: input.request.parentToolCallId,
    parentSessionId: input.request.sessionId,
    prompt: input.request.prompt,
    startedAt: input.startedAt,
    status: input.status,
    taskType: "local_agent",
    executionGeneration: 0,
    sessionReady: false,
    canContinue: false,
    profileSnapshot: input.lifecycle.profile,
    workspaceIdentity: input.request.workspaceIdentity,
    workspaceRoot: input.request.workspaceRoot,
    traceContext: input.lifecycle.runTraceContext,
    type: "local_agent",
    turnId: input.request.turnId,
  };
}

function withoutRuntimeMessageState(task: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  const { messageSink: _messageSink, pendingMessages: _pendingMessages, ...snapshot } = task;
  return snapshot;
}

interface StoppedBackgroundAgentTask {
  previousTask: RuntimeTaskSnapshot;
  task: RuntimeTaskSnapshot;
  totalDurationMs: number;
  traceContext: TraceContext;
}

const BACKGROUND_AGENT_STOPPED_STATE = {
  backgroundEventStatus: "cancelled",
  message: "Background agent task stopped.",
  notificationStatus: "stopped",
  registryStatus: "killed",
  subagentEventStatus: "stopped",
} as const;

function createBackgroundStoppedTask(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
): StoppedBackgroundAgentTask | undefined {
  const current = registry.get(task.taskId);
  if (!current || isTerminalRuntimeTask(current)) return undefined;

  const completedAt = new Date();
  const totalDurationMs = Math.max(0, completedAt.getTime() - current.startedAt.getTime());
  const stopped: RuntimeTaskSnapshot = {
    ...withoutRuntimeMessageState(current),
    status: BACKGROUND_AGENT_STOPPED_STATE.registryStatus,
    completedAt,
    error: BACKGROUND_AGENT_STOPPED_STATE.message,
    usage: {
      durationMs: totalDurationMs,
    },
  };

  const traceContext = traceContextFromRuntimeTask(stopped);
  return { previousTask: current, task: stopped, totalDurationMs, traceContext };
}

async function finalizeBackgroundStopped(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  stopped: StoppedBackgroundAgentTask,
  onCommitted?: () => void,
): Promise<RuntimeTaskSnapshot | undefined> {
  const notification = formatLocalAgentTaskNotification({
    agentId: stopped.task.agentId,
    agentType: stopped.task.agentType,
    description: stopped.task.description,
    outputFile: stopped.task.outputFile ?? "",
    parentToolCallId: String(stopped.task.parentToolCallId ?? stopped.task.taskId),
    status: BACKGROUND_AGENT_STOPPED_STATE.notificationStatus,
    totalDurationMs: stopped.totalDurationMs,
  });
  await writeStoppedAgentArtifacts(stopped.task);
  registry.update(stopped.task.taskId, (current) => ({
    ...stopped.task,
    notified: current.notified,
  }));
  const enqueued = enqueueBackgroundNotification(
    options,
    registry,
    stopped.task.taskId,
    notification,
    stopped.traceContext,
  );
  if (!enqueued) {
    registry.register(stopped.previousTask);
    throw new Error(
      `Background agent task stopped notification was not enqueued: ${stopped.task.taskId}`,
    );
  }

  const committed = registry.get(stopped.task.taskId);
  if (!committed) return undefined;
  onCommitted?.();

  await emitRuntimeTaskBackgroundCompletedEvent(options, committed, stopped.traceContext);
  await emitRuntimeTaskSubagentStoppedEvent(
    options,
    committed,
    stopped.traceContext,
    stopped.totalDurationMs,
  );
  options.logger?.info("Subagent background task stopped", {
    ...traceContextToLogContext(stopped.traceContext),
    agentId: stopped.task.agentId,
    event: "subagent.background.stopped",
    module: "core.subagent",
    status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
  });
  return committed;
}

async function emitRuntimeTaskBackgroundCompletedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.BackgroundTaskCompleted,
    task.parentSessionId,
    {
      taskId: task.taskId,
      toolCallId: String(task.parentToolCallId ?? task.taskId),
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      cancellable: false,
      description: task.description,
      status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      terminalId: task.taskId,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

async function emitRuntimeTaskSubagentStoppedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
  totalDurationMs: number,
): Promise<void> {
  if (!task.parentSessionId) return;
  const recoveredUsage = task.childSessionId
    ? await recoverSubagentUsage(options, task.childSessionId)
    : undefined;
  const event = createSessionEvent(
    SessionEventType.SubagentStopped,
    task.parentSessionId,
    {
      agentId: task.agentId,
      agentType: task.agentType,
      background: true,
      childSessionId: task.childSessionId,
      parentToolCallId: task.parentToolCallId,
      status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
      outputFile: task.outputFile,
      totalDurationMs,
      ...(recoveredUsage ? { totalToolUseCount: recoveredUsage.toolUseCount } : {}),
      ...(recoveredUsage?.reasoningDurationMs === undefined
        ? {}
        : { totalReasoningDurationMs: recoveredUsage.reasoningDurationMs }),
      error: task.error,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

function enqueueBackgroundNotification(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  taskId: string,
  message: string,
  traceContext: TraceContext,
): boolean {
  if (!options.enqueueParentTaskNotification) {
    options.logger?.warn("Skipped subagent background notification without parent queue", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.skipped",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  const task = registry.get(taskId);
  if (!task || task.notified) {
    options.logger?.debug("Skipped duplicate subagent background notification", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.duplicate",
      module: "core.subagent",
      reason: task ? "already_notified" : "task_missing",
      taskId,
    });
    return false;
  }

  try {
    options.enqueueParentTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: task.description.trim() || taskId,
        workId: taskId,
      },
      taskId,
      text: message,
      traceContext,
    });
  } catch (error) {
    options.logger?.warn("Failed to enqueue subagent background notification", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.background.notification.failed",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  registry.update(taskId, (current) =>
    current.notified
      ? current
      : {
          ...current,
          notified: true,
        },
  );
  options.logger?.info?.("Subagent background notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "subagent.background.notification.enqueued",
    module: "core.subagent",
    taskId,
  });
  return true;
}

function traceContextFromRuntimeTask(task: RuntimeTaskSnapshot): TraceContext {
  return (
    task.traceContext ?? {
      traceId: createTraceId(),
      spanId: `span_${task.taskId}`,
      sessionId: task.parentSessionId,
      turnId: task.turnId,
    }
  );
}

async function emitSubagentEvent(
  options: ExploreSubagentPortOptions,
  type: SessionEventType,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const event = createSessionEvent(type, request.sessionId, payload, {
    turnId: request.turnId,
    traceId: traceContext.traceId,
  });
  await options.emitParentEvent(event, traceContext);
}

function createTerminalOutput(input: {
  status: "failed" | "cancelled";
  lifecycle: SubagentLifecycle;
  request: SubagentRunRequest;
  errorMessage: string;
  totalDurationMs: number;
  canContinue: boolean;
  contextReset?: boolean;
  recoveredUsage?: SubagentRecoveredUsage;
}): AgentTerminalOutput {
  return {
    status: input.status,
    agentId: input.lifecycle.agentId,
    childSessionId: input.lifecycle.childSessionId,
    canContinue: input.canContinue,
    ...(input.contextReset ? { contextReset: true } : {}),
    agentType: input.request.agentType,
    description: input.request.description,
    prompt: input.request.prompt,
    content: [{ type: "text", text: input.errorMessage }],
    error: input.errorMessage,
    // 读不到子会话事件时缺席 = 未知。落盘写 0 会被冷恢复当成真实统计。
    ...(input.recoveredUsage ? { totalToolUseCount: input.recoveredUsage.toolUseCount } : {}),
    ...(input.recoveredUsage?.reasoningDurationMs === undefined
      ? {}
      : { totalReasoningDurationMs: input.recoveredUsage.reasoningDurationMs }),
    totalDurationMs: input.totalDurationMs,
  };
}

/**
 * 失败/取消终态没有 child TurnResult，只能回读子会话已落库事件。
 * 读不到时返回 undefined，调用方按「无统计」处理，不得猜测。
 */
async function recoverSubagentUsage(
  options: ExploreSubagentPortOptions,
  childSessionId: SessionId,
): Promise<SubagentRecoveredUsage | undefined> {
  if (!options.readChildSessionEvents) return undefined;
  try {
    const events = await options.readChildSessionEvents(childSessionId);
    const reasoningDurationMs = resolveSubagentReasoningDurationMs(events);
    return {
      toolUseCount: resolveSubagentToolUseCount(events),
      ...(reasoningDurationMs === undefined ? {} : { reasoningDurationMs }),
    };
  } catch {
    // 终态统计失败不能改写终态本身；缺统计好过伪造 0。
    return undefined;
  }
}

async function writeTerminalAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  output: AgentTerminalOutput,
  errorMessage: string,
): Promise<void> {
  try {
    await writeAgentOutputFiles(lifecycle, errorMessage);
    await writeAgentMetadataFile(lifecycle, request, output.status, {
      completedAt: new Date().toISOString(),
      totalDurationMs: output.totalDurationMs,
      error: errorMessage,
    });
  } catch {
    // 结果身份由 registry/output 返回；sidecar 写失败不能再次吞掉 agentId。
  }
}

async function writeCompletedAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  output: AgentCompletedOutput,
): Promise<void> {
  const text = output.content.map((block) => block.text).join("\n\n");
  await writeAgentOutputFiles(lifecycle, text);
  // 子 agent 事件已由 session event store 持久化，不再重复写入 transcript sidecar。
  await writeAgentMetadataFile(lifecycle, request, "completed", {
    completedAt: new Date().toISOString(),
    totalDurationMs: output.totalDurationMs,
    totalTokens: output.totalTokens,
    totalToolUseCount: output.totalToolUseCount,
    usage: output.usage,
  });
}

async function writeStoppedAgentArtifacts(task: RuntimeTaskSnapshot): Promise<void> {
  if (!task.outputFile) return;
  const outputDir = dirname(task.outputFile);
  const content = `${BACKGROUND_AGENT_STOPPED_STATE.message}\n`;
  await writeTextFile(task.outputFile, content);
  await writeTextFile(join(outputDir, "task.output"), content);
  await writeTextFile(
    join(outputDir, "metadata.json"),
    `${JSON.stringify(
      {
        agentId: task.agentId,
        childSessionId: task.childSessionId,
        completedAt: new Date().toISOString(),
        description: task.description,
        outputFile: task.outputFile,
        parentSessionId: task.parentSessionId,
        parentToolUseId: task.parentToolCallId,
        profileId: task.agentType,
        prompt: task.prompt,
        status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
        taskOutputFile: join(outputDir, "task.output"),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function writeAgentOutputFiles(
  lifecycle: Pick<SubagentLifecycle, "outputFile" | "taskOutputFile">,
  content: string,
): Promise<void> {
  await writeTextFile(lifecycle.outputFile, content);
  await writeTextFile(lifecycle.taskOutputFile, content);
}

async function writeAgentMetadataFile(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  status: "running" | "completed" | "failed" | "cancelled" | "stopped",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeTextFile(
    lifecycle.metadataFile,
    `${JSON.stringify(
      {
        agentId: lifecycle.agentId,
        childSessionId: lifecycle.childSessionId,
        createdAt: new Date(lifecycle.startedAt).toISOString(),
        cwd: request.workingDirectory,
        description: request.description,
        metadataFile: lifecycle.metadataFile,
        outputFile: lifecycle.outputFile,
        parentSessionId: request.sessionId,
        parentToolUseId: request.parentToolCallId,
        profileId: request.agentType,
        profileSnapshot: lifecycle.profile,
        prompt: request.prompt,
        status,
        taskOutputFile: lifecycle.taskOutputFile,
        updatedAt: new Date().toISOString(),
        workspaceRoot: request.workspaceRoot,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function aggregateModelUsage(events: SessionEvent[]): ModelUsage | undefined {
  let usage: ModelUsage | undefined;

  for (const event of events) {
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload;
    if (!isRecord(payload) || !isRecord(payload.usage)) {
      continue;
    }

    const modelUsage = payload.usage as ModelUsage;
    if (!hasModelUsage(modelUsage)) continue;
    usage ??= {};
    addUsage(usage, modelUsage);
  }

  return usage;
}

function resolveSubagentToolUseCount(events: SessionEvent[]): number {
  let turnCompleteToolCallCount = 0;
  let sawTurnCompleteToolCallCount = false;
  // 嵌套子代理的工具调用不在本会话的 loopState 里：child 的 toolCallCount
  // 只数到 grandchild 的 launcher 为止，必须把 SubagentStopped 的合计再叠加一层，
  // 才与 reasoning 的递归口径一致。
  let nestedToolCallCount = 0;

  for (const event of events) {
    if (event.type === SessionEventType.SubagentStopped && isRecord(event.payload)) {
      const nested = event.payload.totalToolUseCount;
      if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) {
        nestedToolCallCount += nested;
      }
      continue;
    }
    if (event.type !== SessionEventType.TurnComplete || !isRecord(event.payload)) {
      continue;
    }
    const toolCallCount = event.payload.toolCallCount;
    if (typeof toolCallCount !== "number" || !Number.isFinite(toolCallCount)) {
      continue;
    }
    sawTurnCompleteToolCallCount = true;
    turnCompleteToolCallCount += toolCallCount;
  }

  if (sawTurnCompleteToolCallCount) {
    return turnCompleteToolCallCount + nestedToolCallCount;
  }

  // ToolCallResult/ToolCallError 会直接 append 到 event store，
  // 不一定回填进 child TurnResult.events；child TurnComplete 里的 toolCallCount
  // 才是运行时 loopState 累计出的权威子 agent 工具调用数。
  return (
    events.filter(
      (event) =>
        event.type === SessionEventType.ToolCallResult ||
        event.type === SessionEventType.ToolCallError,
    ).length + nestedToolCallCount
  );
}

function resolveSubagentReasoningDurationMs(events: SessionEvent[]): number | undefined {
  const openReasoning = new Map<string, number>();
  let totalMs = 0;
  let sawReasoning = false;

  for (const event of events) {
    if (event.type === SessionEventType.ModelStreaming && isRecord(event.payload)) {
      const kind = event.payload.kind;
      if (kind === "reasoning_start" || kind === "reasoning_end") {
        sawReasoning = true;
        const key =
          typeof event.payload.partId === "string"
            ? event.payload.partId
            : typeof event.payload.assistantMessageId === "string"
              ? event.payload.assistantMessageId
              : "default";
        if (kind === "reasoning_start") {
          openReasoning.set(key, event.timestamp.getTime());
        } else {
          const startedAt = openReasoning.get(key);
          if (startedAt !== undefined) {
            totalMs += Math.max(0, event.timestamp.getTime() - startedAt);
            openReasoning.delete(key);
          }
        }
      }
    }
    if (event.type === SessionEventType.SubagentStopped && isRecord(event.payload)) {
      const nestedDuration = event.payload.totalReasoningDurationMs;
      if (
        typeof nestedDuration === "number" &&
        Number.isFinite(nestedDuration) &&
        nestedDuration >= 0
      ) {
        sawReasoning = true;
        totalMs += nestedDuration;
      }
    }
  }

  return sawReasoning ? Math.max(0, Math.round(totalMs)) : undefined;
}

function addUsage(target: ModelUsage, next: ModelUsage): void {
  addOptionalUsageNumber(target, "inputTokens", next.inputTokens);
  addOptionalUsageNumber(target, "outputTokens", next.outputTokens);
  addOptionalUsageNumber(target, "totalTokens", resolveTotalTokens(next));
  addOptionalUsageNumber(target, "cacheReadTokens", next.cacheReadTokens);
  addOptionalUsageNumber(target, "cacheWriteTokens", next.cacheWriteTokens);
  addOptionalUsageNumber(target, "reasoningTokens", next.reasoningTokens);
  const webSearchRequests = next.serverToolUse?.webSearchRequests ?? 0;
  const webFetchRequests = next.serverToolUse?.webFetchRequests ?? 0;
  if (webSearchRequests > 0 || webFetchRequests > 0) {
    target.serverToolUse ??= {};
    target.serverToolUse.webSearchRequests =
      (target.serverToolUse.webSearchRequests ?? 0) + webSearchRequests;
    target.serverToolUse.webFetchRequests =
      (target.serverToolUse.webFetchRequests ?? 0) + webFetchRequests;
  }
}

function addOptionalUsageNumber(
  target: ModelUsage,
  key: keyof Pick<
    ModelUsage,
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningTokens"
  >,
  value: number | undefined,
): void {
  if (value === undefined) return;
  target[key] = (target[key] ?? 0) + value;
}

function resolveTotalTokens(usage: ModelUsage): number | undefined {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return getModelUsageTotalTokens(usage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAllowedTools(
  profile: AgentProfile,
  options: ExploreSubagentPortOptions,
): readonly string[] {
  const profileTools = isBuiltInExploreAgentProfile(profile)
    ? (options.getAllowedTools?.(profile) ?? EXPLORE_AGENT_ALLOWED_TOOLS)
    : profile.tools;
  const baseTools = [...(profileTools ?? [])];
  const disallowed = new Set(profile.disallowedTools ?? []);
  if (profile.skills && profile.skills.length > 0 && !disallowed.has("Skill")) {
    baseTools.push("Skill");
  }
  return filterSubagentChildToolNames(baseTools, profile.disallowedTools);
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
