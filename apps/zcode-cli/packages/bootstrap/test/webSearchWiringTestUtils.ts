import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { AiSdkModelAdapter, type CreateAiSdkModelOptions } from "@zcode/adapters/model";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  createModelId,
  createModelProviderId,
  type ActiveWebSearchProvider,
  type Logger,
  type LoggerFactory,
  type Model,
  type ModelRequest,
  type ModelSelection,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchPort,
} from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ProviderApiConfig,
  ProviderConfig,
  createRegistryModelConfig,
  createRegistryProviderConfig,
  type Provider,
} from "@zcode/provider";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";

export const TEST_SELECTION: ModelSelection = {
  providerId: "demo",
  modelId: "model-a",
  options: { reasoningLevel: "low" },
};

/** 假模型唯一发出的 WebSearch 查询；断言端口收到的 input 与它一致。 */
export const TEST_SEARCH_QUERY = "ycode web search";

export const TEST_SEARCH_PROVIDER: ActiveWebSearchProvider = {
  providerId: "personal:deepseek-main",
  templateId: "deepseek",
  endpoint: {
    kind: "rest",
    endpoint: "https://search.example.test/",
    defaultPriority: 3,
    billing: "per-call",
  },
  apiKey: "test-only-key",
};

export interface StubWebSearchPort extends WebSearchPort {
  readonly searchCalls: Array<{
    input: WebSearchInput;
    options: { abortSignal?: AbortSignal };
    provider: ActiveWebSearchProvider;
  }>;
}

export function createStubWebSearchPort(): StubWebSearchPort {
  const searchCalls: StubWebSearchPort["searchCalls"] = [];
  return {
    searchCalls,
    resolveActiveProvider: () => TEST_SEARCH_PROVIDER,
    async search(input, provider, options): Promise<WebSearchOutput> {
      searchCalls.push({ input, provider, options });
      return {
        query: input.query,
        results: [
          { title: "Stub result", url: "https://stub.example/websearch", snippet: "stub snippet" },
        ],
        sources: [],
        durationMs: 1,
      };
    },
  };
}

export function createInactiveWebSearchPort(): StubWebSearchPort {
  return { ...createStubWebSearchPort(), resolveActiveProvider: () => undefined };
}

export async function createIsolatedWorkspace(t: TestContext, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    cleanupWith(cleanup: () => void | Promise<void>) {
      cleanups.push(cleanup);
    },
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      ZCODE_DATA_BASE_DIR: join(root, ".zcode-data"),
      ZCODE_STORAGE_DIR: join(root, ".zcode-storage"),
    },
  };
}

export function createFakeProviderRegistry(): ProviderRegistryModelSource {
  const providerConfig = createRegistryProviderConfig(
    new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "test-only-key" }),
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: "https://model.example.test/v1",
      }),
    }),
  );
  const modelConfig = createRegistryModelConfig(
    ModelConfig.fromData({
      enabled: true,
      properties: TEST_MODEL_PROPERTIES,
      optionSpecs: TEST_MODEL_OPTION_SPECS,
    }),
  );
  assert.ok(providerConfig.ok, "测试供应商配置必须通过完整校验");
  assert.ok(modelConfig.ok, "测试模型配置必须通过完整校验");
  const provider: Provider = {
    providerId: TEST_SELECTION.providerId,
    config: providerConfig.config,
    models: [{ modelId: TEST_SELECTION.modelId, config: modelConfig.config }],
  };
  return {
    getView: () => ({ revision: 1, providers: [provider] }),
    getProvider: (id) => (id === provider.providerId ? provider : undefined),
    getModel: (providerId, modelId) =>
      providerId === provider.providerId
        ? provider.models.find((model) => model.modelId === modelId)
        : undefined,
    validateSelection: () => ({ ok: true }),
    onDidChange: () => () => {},
  };
}

export function createTempSessionStore(root: string): SqliteSessionStore {
  return new SqliteSessionStore({ dbPath: join(root, "session.sqlite") });
}

export function createSilentLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  };
  return logger;
}

export function createSilentLoggerFactory(): LoggerFactory {
  const logger = createSilentLogger();
  return { createLogger: () => logger, withContext: () => logger, setLevel: () => {} };
}

const TEST_MODEL_PROPERTIES: Model["properties"] = {
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
};
const TEST_MODEL_OPTION_SPECS: Model["optionSpecs"] = {
  reasoningLevel: { values: ["low"], map: "{}" },
  maxOutputTokens: { max: 8192, map: "{}" },
};

export class FakeModelAdapter extends AiSdkModelAdapter {
  readonly requests: ModelRequest[] = [];
  private calledWebSearch = false;

  constructor() {
    super({ env: {}, modelIoRecordingEnabled: false });
  }

  override createModel(options: CreateAiSdkModelOptions): Model {
    const model: Model = {
      providerId: createModelProviderId(options.providerId),
      modelId: createModelId(options.modelId),
      properties: TEST_MODEL_PROPERTIES,
      optionSpecs: TEST_MODEL_OPTION_SPECS,
      options: options.options ?? {},
      bind: (bound) => this.createModel({ ...options, options: { ...options.options, ...bound } }),
      generateText: async (request) => {
        this.requests.push(request);
        const callSearch =
          !this.calledWebSearch && request.tools?.some((tool) => tool.name === "WebSearch");
        if (callSearch) this.calledWebSearch = true;
        return {
          text: callSearch ? "" : "finished",
          finishReason: callSearch ? "tool-calls" : "stop",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          toolCalls: callSearch
            ? [{ id: "search-call", name: "WebSearch", input: { query: TEST_SEARCH_QUERY } }]
            : [],
        };
      },
      async *streamText() {
        throw new Error("测试应关闭模型流式输出");
      },
    };
    return model;
  }
}
