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
  type SubagentIdentityResolution,
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
  DEFAULT_SUBAGENT_TYPE,
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

/** SessionStore 支撑的持久化身份解析入口；未注入时只认 live registry。 */
export type SubagentPortIdentityResolver = (
  agentId: string,
) => Promise<SubagentIdentityResolution | null>;

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
  /**
   * 按 agentId 解析持久化身份。live registry 为空时（例如父进程重启或切换 Parent
   * Runtime）靠它找回 child transcript；解析结果里的 child 实体用于校验 taskType 与
   * workspace，不提供时退化为"只认 live registry"。
   */
  resolveSubagentIdentity?: SubagentPortIdentityResolver;
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
        lifecycle.executionGeneration,
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
      // 本次 execution 独占的就绪事实。catch 里的 contextReset 判定读它，
      // 不能读 registry——那里可能是上一代或下一代的状态。
      const executionState = { sessionReady: false };
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
          executionState,
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
          contextReset: !executionState.sessionReady,
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
        // 只收束 stop 实际观察到的那一代。旧实现用 agentId 单键 get+delete，
        // 会把新 generation 刚注册的 controller 一起 abort 并删掉。
        const stoppedGeneration = stopped.previousTask.executionGeneration ?? 0;
        const key = abortControllerKey(stopped.previousTask.agentId, stoppedGeneration);
        const controller = abortControllers.get(key);
        if (controller) {
          abortControllers.delete(key);
          controller.abort(new Error(`${BACKGROUND_AGENT_STOPPED_STATE.message}: ${taskId}`));
        }
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
  /** 本次 execution 的代号；abort 句柄按它分桶，避免旧代收尾误杀新代。 */
  executionGeneration: number;
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

/**
 * abort 句柄按 `agentId + executionGeneration` 复合键存放。
 *
 * 只用 agentId 单键时，旧 generation 的 stop 会命中新 generation 刚注册的 controller
 * 并把它 abort 掉——新 execution 会在自己都没开始前被上一个 execution 的收尾动作杀死。
 * 复合键让停止动作只能作用于它真正观察到的那一代。
 */
function abortControllerKey(agentId: string, generation: number): string {
  return `${agentId}#${generation}`;
}

function createSubagentTaskAbortController(
  abortControllers: Map<string, AbortController>,
  agentId: string,
  generation: number,
  parentSignal?: AbortSignal,
): SubagentTaskAbortHandle {
  const controller = new AbortController();
  const key = abortControllerKey(agentId, generation);
  abortControllers.set(key, controller);
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
    if (abortControllers.get(key) === controller) {
      abortControllers.delete(key);
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
    // 首次执行的 generation 由 registry 快照决定（0）；后续续跑走
    // createContinuationLifecycle，那里从 claimed task 读递增后的值。
    executionGeneration: 0,
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
  // 冷恢复的 snapshot 没有 outputFile（旧进程的临时目录已失效），要重新落一个。
  // 父 session 缺席时不能把它塞进 join——undefined 会让 path 解析直接抛错，
  // 整个续跑变成崩溃而不是一次正常执行。
  const scope = request.sessionId ?? task.parentSessionId ?? "detached";
  const outputFile =
    task.outputFile ?? join(tmpdir(), "zcode-agents", scope, task.agentId, "output.txt");
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
    executionGeneration: task.executionGeneration ?? 1,
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
  // live registry 里的 task 是本 runtime 刚从当前请求建的，不存在跨 workspace 风险，
  // 缺 scope 时按放行处理。真正的隔离在 hydrateTerminalAgentFromStore：冷恢复的
  // 历史 Agent 两侧 scope 必须都存在且相等，否则不采用。
  return !actual || !expected || actual === expected;
}

/**
 * live registry 未命中时按持久化身份冷恢复一个**终态** snapshot 并注册进当前 registry。
 *
 * 三个刻意的约束：
 * 1. 只注册终态，不伪造 running——真正开始新 execution 必须走既有 CAS claim，
 *    否则并发 SendMessage 会同时启动两个 child。
 * 2. child 必须真的存在且 taskType 是 subagent_child，否则返回 undefined 让上层拒绝。
 *    解析器已经做过这层校验，这里再挡一次，避免解析器被替换成宽松实现时静默放行。
 * 3. workspace scope 两侧都缺失时不采用。历史记录可能来自别的 workspace，
 *    宁可拒绝也不能串线。
 */
async function hydrateTerminalAgentFromStore(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  request: SubagentSendMessageRequest,
): Promise<RuntimeTaskSnapshot | undefined> {
  const resolve = options.resolveSubagentIdentity;
  if (!resolve) return undefined;

  let resolution: SubagentIdentityResolution | null;
  try {
    resolution = await resolve(request.to);
  } catch (error) {
    options.logger?.warn("Subagent identity resolution failed", {
      module: "core.subagent",
      agentId: request.to,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (!resolution) return undefined;

  const { binding, child } = resolution;
  if (child.taskType !== "subagent_child") return undefined;
  if (String(child.id) !== binding.childSessionId) return undefined;

  const workspaceIdentity = binding.workspaceIdentity?.trim();
  const workspaceRoot = binding.workspaceRoot?.trim();
  const requestScope = request.workspaceIdentity?.trim() || request.workspaceRoot?.trim();
  const bindingScope = workspaceIdentity || workspaceRoot;
  // 身份行存在但 scope 缺失的旧记录不能跨 runtime 采用：无法证明它属于当前 workspace。
  if (!bindingScope || !requestScope || bindingScope !== requestScope) return undefined;

  // 冷恢复出来的是终态 Agent。真实终态状态由 child transcript 决定，这里只登记
  // "已完成过一次、可以继续"，避免凭空编造 failed/cancelled 与耗时。
  const profile = readPersistedAgentProfile(binding.profile);
  const snapshot: RuntimeTaskSnapshot = {
    taskId: binding.agentId,
    agentId: binding.agentId,
    agentType: binding.agentType || DEFAULT_SUBAGENT_TYPE,
    childSessionId: child.id,
    description: profile?.description ?? `Recovered agent ${binding.agentId}`,
    isBackgrounded: false,
    outputFile: undefined,
    parentToolCallId: request.parentToolCallId,
    // provenance 保留旧父会话；新 execution 的 owner 是当前父 session 与 turn。
    parentSessionId: child.parentID,
    startedAt: new Date(child.time.created),
    completedAt: new Date(child.time.updated),
    status: "completed",
    taskType: "local_agent",
    type: "local_agent",
    // 新 registry 从 0 开始。冷恢复不是原 execution 的延续。
    executionGeneration: 0,
    sessionReady: true,
    canContinue: true,
    adoptedFromStore: true,
    ...(profile ? { profileSnapshot: profile } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };

  const existing = registry.get(snapshot.taskId);
  // 并发的两个 SendMessage 可能同时冷恢复同一个 Agent；先到者注册，后到者复用，
  // 真正的唯一性仍由后面的 CAS claim 决定。
  return existing ?? (registry.register(snapshot), snapshot);
}

/**
 * 身份行里的 profile 是 JSON 快照，字段可能缺失或来自旧版本。
 * 缺必填字段就返回 undefined，让上层回退到按当前请求解析 profile——
 * 半个 profile 比没有 profile 更危险，它会被当成完整配置继续跑。
 */
function readPersistedAgentProfile(
  raw: Record<string, unknown> | undefined,
): AgentProfile | undefined {
  if (!raw) return undefined;
  const { name, description, systemPrompt, source } = raw;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof systemPrompt !== "string" ||
    (source !== "built-in" && source !== "project" && source !== "user")
  ) {
    return undefined;
  }
  return raw as unknown as AgentProfile;
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
  const message = createRuntimeTaskPendingMessage(request);
  let task = registry.get(request.to);
  if (!task || task.type !== "local_agent") {
    // live registry 是进程内缓存，重启或切换 Parent Runtime 后必然为空。直接在这里
    // 报"找不到本地 Agent"会让所有历史 Agent 永久失联，所以先查持久化身份。
    task = await hydrateTerminalAgentFromStore(options, registry, request);
  }
  if (!task) {
    return createSendMessageFailure(request, `No local agent found for target ${request.to}.`);
  }
  if (!isTerminalRuntimeTask(task)) {
    return deliverMessageToRunningAgent(registry, task, message);
  }
  // 冷恢复的 provenance 是旧 parent session；只有同 workspace 的当前 Parent Runtime
  // 可以采用它。跨 parent 拒绝保留在下面，但 adoption 时跳过——这正是换 runtime 的目的。
  if (task.adoptedFromStore && request.sessionId && task.parentSessionId) {
    if (!sameAgentWorkspace(task, request)) {
      return createSendMessageFailure(
        request,
        `Agent ${task.agentId} belongs to another workspace.`,
      );
    }
  } else {
    if (request.sessionId && task.parentSessionId && task.parentSessionId !== request.sessionId) {
      return createSendMessageFailure(
        request,
        `Agent ${task.agentId} belongs to another parent session.`,
      );
    }
    if (!sameAgentWorkspace(task, request)) {
      return createSendMessageFailure(
        request,
        `Agent ${task.agentId} belongs to another workspace.`,
      );
    }
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
    generation,
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
  // 本次 execution 独占的就绪事实；下面 catch 里的 contextReset 判定读它，
  // 不能读 registry——CAS 已经允许新一代接管同一个 agentId。
  const executionState = { sessionReady: false };
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
        executionState,
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
      contextReset: !executionState.sessionReady,
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
    if (executionOptions.executionState) executionOptions.executionState.sessionReady = true;
  };
  // 进度回传与 inactivity watchdog 共用同一条活动信号：子代理每条事件都会调它。
  // 上报器挂在 runExploreAgent 挂起期，finally 收尾，保证异常路径也不留残余。
  const progressReporter = createSubagentProgressReporter({ options, request, lifecycle });
  const reportActivity = () => {
    monitorOptions.reportActivity?.();
    progressReporter.reportActivity();
  };
  let childResult: ExploreSubagentRuntimeResult;
  try {
    childResult = await options.runExploreAgent(
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
        reportActivity,
        resumeFromStore: executionOptions.resumeFromStore,
        systemPrompt: lifecycle.profile.systemPrompt,
        workingDirectory: request.workingDirectory,
        workspaceRoot: request.workspaceRoot,
        traceContext: lifecycle.childTraceContext,
      },
      runOptions,
    );
  } finally {
    progressReporter.stop();
  }
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
  /**
   * 本次 execution 的 child session 就绪事实，由调用方持有。
   * 终态的 `contextReset` 必须读它——读 registry 拿到的是别的 execution 的状态，
   * 会把一次正常完成的续跑误标成 context reset。
   */
  executionState?: { sessionReady: boolean };
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

/**
 * 运行中子代理的累计用量回传。
 *
 * 父工作段状态行此前只在子代理结束时才拿到数字——`runAgentToCompletion` 在
 * `runExploreAgent` 返回之后才统计，用量随 `SubagentStopped` 一次性到达。于是子代理
 * 跑的那几分钟里，状态行冻在「工具 1 次」（那 1 次只是父侧 Agent launcher），
 * 用户看到的是"外面不同步"。
 *
 * 这里用与终态完全相同的 `recoverSubagentUsage` 取数，所以直播数字是终态数字的单调
 * 前缀，两条口径按构造一致，不存在两套数字对不上的可能。
 *
 * 触发源是子代理自身的每条事件（`reportActivity`），再过 1500ms 节流：空闲子代理
 * 没有事件就没有 flush，没有事件写入。累计值未变化时也不发——数字不动就没有
 * 理由产生一条 delta 去触发父侧重算。
 */
const SUBAGENT_PROGRESS_INTERVAL_MS = 1500;

function createSubagentProgressReporter(input: {
  options: ExploreSubagentPortOptions;
  request: SubagentRunRequest;
  lifecycle: SubagentLifecycle;
}): { reportActivity: () => void; stop: () => void } {
  const { options, request, lifecycle } = input;
  let lastFlushedAtMs = 0;
  let lastToolCallCount: number | undefined;
  let lastReasoningDurationMs: number | undefined;
  let stopped = false;

  const flush = async (): Promise<void> => {
    const usage = await recoverSubagentUsage(options, lifecycle.childSessionId);
    // 终态事件可能已经发出；此时再补一条进度只会让已冻结的行多一次无谓写入。
    if (stopped || !usage) return;
    if (
      usage.toolUseCount === lastToolCallCount &&
      usage.reasoningDurationMs === lastReasoningDurationMs
    ) {
      return;
    }
    lastToolCallCount = usage.toolUseCount;
    lastReasoningDurationMs = usage.reasoningDurationMs;
    try {
      await emitSubagentEvent(
        options,
        SessionEventType.SubagentProgress,
        request,
        lifecycle.childTraceContext,
        {
          agentId: lifecycle.agentId,
          childSessionId: lifecycle.childSessionId,
          parentToolCallId: request.parentToolCallId,
          totalToolUseCount: usage.toolUseCount,
          ...(usage.reasoningDurationMs === undefined
            ? {}
            : { totalReasoningDurationMs: usage.reasoningDurationMs }),
        },
      );
    } catch {
      // 进度回传失败不能影响子代理执行；下一拍会自然重试。
    }
  };

  return {
    reportActivity: () => {
      if (stopped) return;
      const nowMs = Date.now();
      if (nowMs - lastFlushedAtMs < SUBAGENT_PROGRESS_INTERVAL_MS) return;
      lastFlushedAtMs = nowMs;
      void flush();
    },
    stop: () => {
      stopped = true;
    },
  };
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

  // 运行中读数：还没有 TurnComplete，只能从工具生命周期事件反推。
  //
  // 这里必须是 scheduled 语义，不能只数结果事件。终态那条路数的是
  // `state.toolCallCount += executableToolCalls.length`——工具进执行器之前就累加了，
  // ToolCallRow 也是由 ToolCallScheduled 创建的。只数 ToolCallResult/ToolCallError
  // 会让并行工具的数字等到最慢那个跑完才跳：子代理界面早已出行，父状态行却不动。
  //
  // 四类事件都收，用 toolCallId 去重：Scheduled 是最早的证据点，其余三类覆盖
  // 「有结果但缺 scheduled」的旧 transcript 形态。四类都不在
  // TRANSIENT_SESSION_EVENT_TYPES 里，运行中一定读得到。缺 toolCallId 的事件跳过，不猜。
  const toolCallIds = new Set<string>();
  for (const event of events) {
    if (
      event.type !== SessionEventType.ToolCallScheduled &&
      event.type !== SessionEventType.ToolCallStarted &&
      event.type !== SessionEventType.ToolCallResult &&
      event.type !== SessionEventType.ToolCallError
    ) {
      continue;
    }
    if (!isRecord(event.payload)) continue;
    const toolCallId = event.payload.toolCallId;
    if (typeof toolCallId === "string" && toolCallId.length > 0) {
      toolCallIds.add(toolCallId);
    }
  }
  return toolCallIds.size + nestedToolCallCount;
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
