import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  InMemorySessionEventStore,
  createModelId,
  createModelProviderId,
  createSessionId,
  createToolCallId,
  createTraceId,
  modelMessageContentToText,
  type ActiveWebSearchProvider,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
  type ModelSelection,
  type SubagentPort,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchPort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentProfile } from "../src/subagent/profile.js";

// websearch-runtime-inheritance.test.ts 的 hermetic 装配：真实 AgentRuntime + 真实子代理
// 工厂，只把模型与 WebSearchPort 换成可断言的假实现。不读真实配置、不发网络请求。

export const ACTIVE_PROVIDER: ActiveWebSearchProvider = {
  providerId: "personal:websearch-test",
  templateId: "jina",
  endpoint: {
    kind: "rest",
    endpoint: "https://s.jina.ai",
    defaultPriority: 5,
    billing: "per-call",
  },
  apiKey: "sk-test",
};

export const OTHER_PROVIDER: ActiveWebSearchProvider = {
  ...ACTIVE_PROVIDER,
  providerId: "personal:websearch-other",
};

export const WEBSEARCH_QUERY = "zcode release";
export const STUB_RESULT_URL = "https://example.test/stub";

const WEBSEARCH_CALL_ID = "call_websearch_1";

export interface StubCall {
  readonly input: WebSearchInput;
  readonly output: WebSearchOutput;
  readonly provider: ActiveWebSearchProvider;
}

export interface StubWebSearchPort extends WebSearchPort {
  readonly calls: StubCall[];
}

export function createStubPort(
  resolveActiveProvider: () => ActiveWebSearchProvider | undefined,
): StubWebSearchPort {
  const calls: StubCall[] = [];
  return {
    calls,
    resolveActiveProvider,
    search: async (input, provider) => {
      const output: WebSearchOutput = {
        query: input.query,
        results: [{ title: "Stub result", url: STUB_RESULT_URL }],
        sources: [],
        durationMs: 1,
      };
      // 先记录再返回：断言同时覆盖「端口被调用」与「端口返回了什么」。
      calls.push({ input, output, provider });
      return output;
    },
  };
}

/**
 * 模拟宿主会话的策略快照：创建端口时冻结外部最新策略，之后的变更不进入本端口。
 * 子代理若错误地重新读取外部策略，就会拿到 OTHER_PROVIDER。
 */
export function createSnapshotStubPort(policy: {
  latest: ActiveWebSearchProvider | undefined;
}): StubWebSearchPort {
  const snapshot = policy.latest;
  return createStubPort(() => snapshot);
}

export interface ToolResultRecord {
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface ModelRequestRecord {
  readonly toolNames: readonly string[];
  readonly toolResults: readonly ToolResultRecord[];
}

export interface FakeModelHost {
  readonly requests: ModelRequestRecord[];
  /** 只发一次 WebSearch 调用，第二次请求收尾。 */
  webSearchCalls: number;
}

function readToolResults(messages: readonly ModelInputMessage[]): ToolResultRecord[] {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => ({
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      content: modelMessageContentToText(message.content),
      isError: message.isError === true,
    }));
}

export const PARENT_SELECTION: ModelSelection = {
  providerId: "demo",
  modelId: "model-a",
  options: { reasoningLevel: "low" },
};

/**
 * 假模型：记录每次请求的工具面与已有工具结果；只在请求真的声明了 WebSearch 时
 * 发一次调用，避免用「未声明工具的假调用」制造假失败/假成功。
 */
export function createFakeModel(selection: ModelSelection, host: FakeModelHost): Model {
  const reasoningLevel = selection.options?.reasoningLevel;
  const build = (boundReasoningLevel: string | undefined): Model => ({
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
        values: boundReasoningLevel ? [boundReasoningLevel] : ["low"],
        map: "{}",
      },
      maxOutputTokens: { max: 8192, map: "{}" },
    },
    options: boundReasoningLevel ? { reasoningLevel: boundReasoningLevel } : {},
    bind(bindOptions) {
      return build(bindOptions?.reasoningLevel ?? reasoningLevel);
    },
    async generateText(request: ModelRequest) {
      const toolNames = (request.tools ?? []).map((tool) => tool.name);
      const shouldCall = toolNames.includes("WebSearch") && host.webSearchCalls === 0;
      host.requests.push({ toolNames, toolResults: readToolResults(request.messages) });
      if (shouldCall) host.webSearchCalls += 1;
      return {
        text: shouldCall ? "" : "done",
        finishReason: shouldCall ? "tool-calls" : "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        toolCalls: shouldCall
          ? [{ id: WEBSEARCH_CALL_ID, name: "WebSearch", input: { query: WEBSEARCH_QUERY } }]
          : [],
      };
    },
    streamText(): AsyncIterable<never> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<never> {
          return {
            next: async () => {
              throw new Error("streamText is not used when modelStreaming is off");
            },
          };
        },
      };
    },
  });
  return build(reasoningLevel);
}

export interface ParentHarness {
  readonly runtime: AgentRuntime;
  readonly internal: AgentRuntimeInternal;
  readonly host: FakeModelHost;
  readonly subagentPort: SubagentPort;
}

export async function createParentHarness(
  t: TestContext,
  options: {
    port?: StubWebSearchPort;
    profiles?: readonly AgentProfile[];
    workingDirectory: string;
  },
): Promise<ParentHarness> {
  const host: FakeModelHost = { requests: [], webSearchCalls: 0 };
  const eventStore = new InMemorySessionEventStore();
  const runtime = new AgentRuntime(
    createSessionId(),
    {
      mode: "yolo",
      // 关闭流式：走 generateText，模型请求的工具面与工具结果可被精确断言。
      modelStreaming: "off",
      modelSelection: PARENT_SELECTION,
      workingDirectory: options.workingDirectory,
      workspacePath: options.workingDirectory,
      language: "zh-CN",
      subagents: {
        enabled: true,
        profiles: options.profiles ?? [],
        // 至少两轮：第一轮工具调用，第二轮把工具结果带回模型。
        maxTurns: 2,
      },
    },
    {
      eventStore,
      modelFactory: (input) => createFakeModel(input.selection, host),
      ...(options.port ? { webSearchPort: options.port } : {}),
    },
  );
  // 收束走 AgentRuntime 的公开方法，不额外持有私有资源。
  t.after(() => runtime.beginShutdown());
  const internal = runtime as unknown as AgentRuntimeInternal;
  const subagentPort = internal.subagentPort;
  if (!subagentPort) throw new Error("AgentRuntime did not create a subagentPort");
  return { runtime, internal, host, subagentPort };
}

export async function runSubagent(
  harness: ParentHarness,
  agentType: string,
  workingDirectory: string,
): Promise<void> {
  await harness.subagentPort.run({
    sessionId: harness.runtime.getSessionId(),
    parentToolCallId: createToolCallId(),
    agentType,
    description: "websearch inheritance probe",
    prompt: "search the web and report back",
    workingDirectory,
    workspaceRoot: workingDirectory,
    trace: { traceId: createTraceId() },
  });
}

export async function createIsolatedWorkspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "zcode-websearch-inherit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
