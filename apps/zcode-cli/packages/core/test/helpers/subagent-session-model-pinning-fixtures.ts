import {
  SESSION_ENTRY_MODEL_GROUP,
  SESSION_ENTRY_MODEL_SELECTION,
  SessionEventType,
  createSessionId,
  createToolCallId,
  createTraceId,
  createModelId,
  createModelProviderId,
  type AgentOutput,
  type Model,
  type ModelEvent,
  type ModelSelection,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionId,
  type SubagentPort,
  type SubagentRunOptions,
  type SubagentSendMessageOptions,
  type SubagentSendMessageResult,
} from "@zcode/contracts";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { ModelGroupSnapshot } from "../../src/runtime/methods/session-model-group.js";
import type { AgentProfile } from "../../src/subagent/profile.js";
import {
  InMemoryPinningSessionStore,
  TestSessionEventStore,
} from "./subagent-session-model-pinning-storage-fixtures.js";

/**
 * 子智能体模型固定绑定（docs/specs/model-group.md 场景 33-37）的真实运行时回归夹具。
 *
 * 这里刻意不 stub `runExploreAgent`：测试必须真正建立 `AgentRuntime`、走
 * `createDefaultSubagentPort` 的首次执行与冷恢复链路，才能让 assertion 落在
 * 「child runtime 实际请求了哪个模型」和「child 自己落了什么 entry/事件」上。
 * 内存 store 只替代持久化介质，身份解析、execution claim、事件顺序与
 * modelFactory 调用都走生产代码。
 */

// 存储替身放在独立 helper 中，这里保留 re-export，测试与 bootstrap 的 import 路径不变。
export { InMemoryPinningSessionStore, TestSessionEventStore };

export interface ModelCallRecord {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevel?: string;
}

export interface PinningBehavior {
  /** 下一次（且仅下一次）generateText 抛出的错误，用于模拟 429 等运行时失败。 */
  nextError?: Error;
}

export interface SharedPinningState {
  readonly store: InMemoryPinningSessionStore;
  readonly eventStore: TestSessionEventStore;
  readonly modelCalls: ModelCallRecord[];
  /** 生产 modelFactory 实际收到的 selection，用于区分“构造期模型”与“本轮请求”。 */
  readonly factorySelections: ModelCallRecord[];
  readonly behavior: PinningBehavior;
  groups: ModelGroupSnapshot[];
}

export interface PinningHarnessOptions {
  readonly profile: AgentProfile;
  readonly groups?: readonly ModelGroupSnapshot[];
  readonly parentSelection: ModelSelection;
  /** 允许解析的测试模型事实，未列出的 provider/model 仍不可用。 */
  readonly modelCatalog?: readonly ModelSelection[];
  /** 测试注入的持久化故障，用于覆盖首次 run admission。 */
  readonly failEntryWrite?: (entry: SessionEntryInfo) => boolean;
  readonly workingDirectory?: string;
  readonly workspaceRoot?: string;
  readonly workspaceIdentity?: string;
}

export interface PinningHarness {
  readonly parentSessionId: SessionId;
  readonly shared: SharedPinningState;
  readonly runtime: AgentRuntime;
  readonly port: SubagentPort;
  /** 最近一次 run 返回的 child session / agent 身份。 */
  readonly lastChildSessionId?: SessionId;
  readonly lastAgentId?: string;
  run(prompt?: string, options?: SubagentRunOptions): Promise<AgentOutput>;
  send(
    agentId: string,
    message?: string,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
  /** 用同一份持久化事实重建 Parent Runtime 与 subagentPort（模拟父进程重启）。 */
  rebuildParent(): PinningHarness;
  entries(sessionId: SessionId, type?: string): SessionEntryInfo[];
  entryData(sessionId: SessionId, type: string): unknown;
  selection(sessionId: SessionId): ModelSelection | undefined;
  groupState(sessionId: SessionId): { intent?: unknown; pickSeed?: string | null } | undefined;
  events(sessionId: SessionId): SessionEvent[];
  childModelCalls(): readonly ModelCallRecord[];
}

export const PINNING_WORKSPACE_ROOT = "C:/ycode-pinning-tests/workspace";
export const PINNING_WORKSPACE_IDENTITY = "workspace:pinned-subagent";
const WORKSPACE_ROOT = PINNING_WORKSPACE_ROOT;
const DEFAULT_TEST_MODEL_CATALOG: readonly ModelSelection[] = [
  { providerId: "demo", modelId: "model-a", options: { reasoningLevel: "low" } },
  { providerId: "demo", modelId: "model-b", options: { reasoningLevel: "high" } },
  { providerId: "demo", modelId: "model-c", options: { reasoningLevel: "high" } },
];

export function createPinnedGroup(overrides: {
  groupId: string;
  name: string;
  members: readonly ModelGroupSnapshot["memberOrder"][number][];
}): ModelGroupSnapshot {
  return {
    groupId: overrides.groupId,
    name: overrides.name,
    memberOrder: overrides.members,
  };
}

export function createSelection(
  providerId: string,
  modelId: string,
  reasoningLevel?: string,
): ModelSelection {
  return {
    providerId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export function createPinningHarness(options: PinningHarnessOptions): PinningHarness {
  const parentSessionId = createSessionId();
  const store = new InMemoryPinningSessionStore();
  store.failEntryWrite = options.failEntryWrite;
  const shared: SharedPinningState = {
    store,
    eventStore: new TestSessionEventStore(),
    modelCalls: [],
    factorySelections: [],
    behavior: {},
    groups: [...(options.groups ?? [])],
  };
  return buildHarness(parentSessionId, options, shared);
}

function buildHarness(
  parentSessionId: SessionId,
  options: PinningHarnessOptions,
  shared: SharedPinningState,
): PinningHarness {
  const workingDirectory = options.workingDirectory ?? WORKSPACE_ROOT;
  const workspaceRoot = options.workspaceRoot ?? workingDirectory;
  const workspaceIdentity = options.workspaceIdentity ?? PINNING_WORKSPACE_IDENTITY;

  const runtime = new AgentRuntime(
    parentSessionId,
    {
      mode: "yolo",
      // 关闭流式：测试走 generateText，模型调用可被精确计数与断言。
      modelStreaming: "off",
      modelSelection: options.parentSelection,
      workingDirectory,
      workspacePath: workingDirectory,
      language: "zh-CN",
      subagents: {
        enabled: true,
        profiles: [options.profile],
        maxTurns: 1,
      },
    },
    {
      eventStore: shared.eventStore.port,
      sessionStore: shared.store.port,
      modelFactory: (input) => {
        shared.factorySelections.push({
          providerId: input.selection.providerId,
          modelId: input.selection.modelId,
          ...(input.selection.options?.reasoningLevel
            ? { reasoningLevel: input.selection.options.reasoningLevel }
            : {}),
        });
        return createFakeModel(input.selection, shared);
      },
      resolveEffectiveModelSelection: (selection) =>
        resolveSelection(
          selection,
          options.modelCatalog ?? [options.parentSelection, ...DEFAULT_TEST_MODEL_CATALOG],
        ),
      modelCatalogPort: {
        // 目录端口只承担「组名单快照」这一条读取路径；模型目录由上面的
        // resolveEffectiveModelSelection 直接给，不需要真实注册表。
        listModels: () => [],
        listModelGroupSnapshots: async () => shared.groups,
      },
    },
  );

  const port = (runtime as unknown as { subagentPort?: SubagentPort }).subagentPort;
  if (!port) throw new Error("AgentRuntime did not create a subagentPort");

  let lastChildSessionId: SessionId | undefined;
  let lastAgentId: string | undefined;

  const harness: PinningHarness = {
    parentSessionId,
    shared,
    runtime,
    port,
    get lastChildSessionId() {
      return lastChildSessionId;
    },
    get lastAgentId() {
      return lastAgentId;
    },
    async run(prompt = "first pinned run", runOptions) {
      const output = await port.run(
        {
          sessionId: parentSessionId,
          parentToolCallId: createToolCallId(),
          agentType: options.profile.name,
          description: "pinned subagent run",
          prompt,
          workingDirectory,
          workspaceRoot,
          workspaceIdentity,
          trace: { traceId: createTraceId() },
        },
        runOptions,
      );
      lastChildSessionId = readChildSessionId(output) ?? lastChildSessionId;
      lastAgentId = output.agentId ?? lastAgentId;
      return output;
    },
    async send(agentId, message = "continue pinned child", sendOptions) {
      const result = await port.sendMessage!(
        {
          sessionId: parentSessionId,
          parentToolCallId: createToolCallId(),
          to: agentId,
          summary: "pinned continuation",
          message,
          workingDirectory,
          workspaceRoot,
          workspaceIdentity,
          trace: { traceId: createTraceId() },
        },
        sendOptions,
      );
      const continuedChildId = result.continuation?.childSessionId;
      if (continuedChildId) lastChildSessionId = continuedChildId as SessionId;
      return result;
    },
    rebuildParent() {
      return buildHarness(parentSessionId, options, shared);
    },
    entries(sessionId, type) {
      return shared.store.entriesFor(sessionId, type);
    },
    entryData(sessionId, type) {
      return shared.store.entriesFor(sessionId, type).at(-1)?.data;
    },
    selection(sessionId) {
      const data = shared.store.entriesFor(sessionId, SESSION_ENTRY_MODEL_SELECTION).at(-1)?.data;
      return typeof data === "object" && data !== null ? (data as ModelSelection) : undefined;
    },
    groupState(sessionId) {
      const data = shared.store.entriesFor(sessionId, SESSION_ENTRY_MODEL_GROUP).at(-1)?.data;
      return typeof data === "object" && data !== null
        ? (data as { intent?: unknown; pickSeed?: string | null })
        : undefined;
    },
    events(sessionId) {
      return shared.eventStore.snapshot(sessionId);
    },
    childModelCalls() {
      return shared.modelCalls;
    },
  };
  return harness;
}

function readChildSessionId(output: AgentOutput): SessionId | undefined {
  return output.childSessionId ? (output.childSessionId as SessionId) : undefined;
}

function resolveSelection(
  selection: ModelSelection,
  catalog: readonly ModelSelection[],
): {
  effectiveSelection: ModelSelection | null;
  selectionIssue?: "model-not-found" | "reasoning-level-missing";
} {
  const model = catalog.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
  if (!model) return { effectiveSelection: null, selectionIssue: "model-not-found" };
  if (!selection.options?.reasoningLevel) {
    // 与生产 resolveEffectiveModelSelection 同口径：模型档位必填。
    return { effectiveSelection: selection, selectionIssue: "reasoning-level-missing" };
  }
  if (
    model.options?.reasoningLevel &&
    model.options.reasoningLevel !== selection.options.reasoningLevel
  ) {
    return { effectiveSelection: null, selectionIssue: "model-not-found" };
  }
  return { effectiveSelection: selection };
}

function createFakeModel(selection: ModelSelection, shared: SharedPinningState): Model {
  const reasoningLevel = selection.options?.reasoningLevel;
  const model: Model = {
    // Model 的 provider/model id 是 branded 类型，用 contracts 的公开构造函数转换。
    providerId: createModelProviderId(selection.providerId),
    modelId: createModelId(selection.modelId),
    displayName: `${selection.providerId}/${selection.modelId}`,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: {
        values: reasoningLevel ? [reasoningLevel] : ["low", "high"],
        map: "{}",
      },
      maxOutputTokens: { max: 8192, map: "{}" },
    },
    options: reasoningLevel ? { reasoningLevel } : {},
    bind(bindOptions) {
      const boundLevel = bindOptions?.reasoningLevel ?? reasoningLevel;
      return createFakeModel(
        {
          providerId: selection.providerId,
          modelId: selection.modelId,
          ...(boundLevel ? { options: { reasoningLevel: boundLevel } } : {}),
        },
        shared,
      );
    },
    async generateText() {
      shared.modelCalls.push({
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(reasoningLevel ? { reasoningLevel } : {}),
      });
      const error = shared.behavior.nextError;
      if (error) {
        shared.behavior.nextError = undefined;
        throw error;
      }
      return {
        text: `pinned-model-response:${selection.modelId}`,
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        toolCalls: [],
      };
    },
    // 非 generator 实现：调用后返回的 AsyncIterable 在首次迭代时以同样的错误拒绝，
    // 与测试里“关闭流式时 streamText 不可用”的语义保持一致。
    streamText(): AsyncIterable<ModelEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
          return {
            next: async () => {
              throw new Error("streamText is not used when modelStreaming is off");
            },
          };
        },
      };
    },
  };
  return model;
}

export function findLastEvent(
  events: readonly SessionEvent[],
  type: string,
): { event: SessionEvent; index: number } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (String(events[index]!.type) === type) return { event: events[index]!, index };
  }
  return undefined;
}

export function isSuccessfulContinuation(result: SubagentSendMessageResult): boolean {
  return result.continuation?.status === "completed";
}

export const MODEL_SELECTED_EVENT = String(SessionEventType.ModelSelected);
export const TURN_STARTED_EVENT = String(SessionEventType.TurnStarted);
