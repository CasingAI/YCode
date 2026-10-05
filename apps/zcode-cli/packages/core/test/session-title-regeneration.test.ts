import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageWithParts,
  ModelSelection,
  SessionInfo,
  SessionTitleSource,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { regenerateSessionTitle } from "../src/runtime/methods/session-title.js";

// 「重新生成标题」是首轮自动生成之外的第二条路径，行为差异刻意与首轮不同。
// 这里锁住四件事：绕过首轮四道闸、素材取会话实际内容、覆盖 custom、三类失败都抛错。
// 最后一类尤其重要：首轮生成失败只 logger.warn 并静默 return，前端无法区分
// 「生成中」与「已卡死」；本路径必须把失败冒泡成 ACK failed。

const TRACE = { traceId: "trace-title", spanId: "span-title" } as never;

const SELECTION: ModelSelection = {
  providerId: "test-provider",
  modelId: "test-model",
} as ModelSelection;

type FakeModelResult = { text: string; finishReason: string; usage?: undefined };

function fakeModel(result: FakeModelResult | (() => FakeModelResult)) {
  const model = {
    providerId: "test-provider",
    modelId: "test-model",
    displayName: "test-model",
    properties: {},
    options: { reasoningLevel: "off" },
    optionSpecs: {
      reasoningLevel: { values: ["off"] },
      maxOutputTokens: { min: 1, max: 4096, default: 1024 },
    },
    bind() {
      return model;
    },
    async generateText() {
      return typeof result === "function" ? result() : result;
    },
    async streamText() {
      throw new Error("not used");
    },
  };
  return model;
}

type UpdateSessionCall = {
  expectedTitleSources?: readonly SessionTitleSource[];
  id: string;
  title: string;
  titleMessageID?: string;
  titleSource: SessionTitleSource;
};

function userMessage(id: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    info: { id, role: "user", sessionID: "sess-title", ...overrides },
    parts: [{ type: "text", text }],
  } as unknown as MessageWithParts;
}

function assistantMessage(id: string, text: string) {
  return {
    info: { id, role: "assistant", sessionID: "sess-title" },
    parts: [{ type: "text", text }],
  } as unknown as MessageWithParts;
}

function fakeRuntime(options: {
  modelResult?: FakeModelResult | (() => FakeModelResult);
  messages?: MessageWithParts[];
  session?: Partial<SessionInfo>;
  titleGenerationAttempted?: boolean;
  withModel?: boolean;
}) {
  const updates: UpdateSessionCall[] = [];
  const appended: Record<string, unknown>[] = [];
  const session: SessionInfo = {
    id: "sess-title",
    title: "旧标题",
    titleSource: "custom",
    taskType: "interactive",
    ...options.session,
  } as SessionInfo;

  const runtime = {
    sessionId: "sess-title",
    // turnNumber 故意设成非 0、attempted 故意置 true：首轮两道闸如果还生效，
    // 本方法会在这里直接 return false，测试就会以「没写库」失败。
    turnNumber: 7,
    sessionTitleGenerationAttempted: options.titleGenerationAttempted ?? true,
    config: {
      taskType: "interactive",
      titleGeneration: options.withModel === false ? undefined : { modelSelection: SELECTION },
    },
    logger: { debug() {}, warn() {}, info() {} },
    agentTelemetry: {
      captureCausation: () => undefined,
      detached: () => ({
        run: (fn: () => unknown) => fn(),
        setResultType() {},
        finishCompleted() {},
        finishFailed() {},
      }),
    },
    sessionStore: {
      getSession: async () => session,
      messages: async () => options.messages ?? [],
      updateSession: async (input: UpdateSessionCall) => {
        updates.push(input);
        const next = { ...session, ...input } as SessionInfo;
        Object.assign(session, next);
        return next;
      },
    },
    modelFactory: () =>
      fakeModel(
        options.modelResult ?? { text: '{"title":"重新生成的标题"}', finishReason: "stop" },
      ),
    getSessionModelSelection: () => (options.withModel === false ? undefined : SELECTION),
    createEvent: (type: string, payload: Record<string, unknown>) => ({ type, ...payload }),
    appendEvent: async (event: Record<string, unknown>) => {
      appended.push(event);
    },
    createModelStatusSink: () => undefined,
    extractToolCallsFromResult: () => [],
  } as unknown as AgentRuntimeInternal;

  return { runtime, updates, appended };
}

test("regenerateSessionTitle：绕过首轮守卫，按会话实际内容生成并覆盖 custom", async () => {
  const { runtime, updates, appended } = fakeRuntime({
    messages: [
      userMessage("m1", "这条会话在排查回车键无响应的问题"),
      assistantMessage("m2", "已经定位到 stdin 的事件绑定被重复注册"),
      userMessage("m3", "后续再补一个回归测试"),
    ],
  });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  const update = updates[0]!;
  assert.equal(update.title, "重新生成的标题");
  assert.equal(update.titleSource, "generated");
  // 覆盖 custom 的关键：CAS 必须把 custom 纳入允许来源，否则写不进去。
  assert.deepEqual(update.expectedTitleSources, ["default", "first_input", "generated", "custom"]);
  assert.equal(update.titleMessageID, "m1");
  // sidecar 自己也会落 ModelRequest / ModelComplete 两条轨迹事件，标题更新是最后一条。
  // 它先于调用方拿到 Promise，UI 清占位符时真标题已就位，不会闪回旧值。
  const titleEvent = appended.find((event) => event.type === "session_title_updated");
  assert.ok(titleEvent, "应发出 session_title_updated 事件");
  assert.equal(titleEvent!.source, "generated");
  assert.equal(titleEvent!.title, "重新生成的标题");
});

test("regenerateSessionTitle：素材跳过 synthetic 与 model-only 用户消息，取首条可见消息", async () => {
  const { runtime, updates } = fakeRuntime({
    messages: [
      userMessage("m0", "系统注入的合成消息", { synthetic: true }),
      userMessage("m1", "只给模型看的消息", { visibility: "model-only" }),
      userMessage("m2", "用户真正问的第一句"),
      assistantMessage("m3", "助手的第一句回答"),
    ],
  });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  // titleMessageID 指向第一条可见真实用户消息，不是被跳过的 m0/m1。
  assert.equal(updates[0]!.titleMessageID, "m2");
});

test("regenerateSessionTitle：只有首条 query 没有助手回复时仍可生成", async () => {
  const { runtime, updates } = fakeRuntime({
    messages: [userMessage("m1", "只有提问还没有回答")],
  });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.titleMessageID, "m1");
});

test("regenerateSessionTitle：空会话显式抛错，不静默 return", async () => {
  const { runtime, updates } = fakeRuntime({ messages: [] });

  await assert.rejects(
    () => regenerateSessionTitle.call(runtime, { traceContext: TRACE }),
    /no conversation content/,
  );
  assert.equal(updates.length, 0);
});

test("regenerateSessionTitle：模型未配置时抛错，前端据此撤占位符", async () => {
  const { runtime, updates } = fakeRuntime({
    messages: [userMessage("m1", "有内容但没有模型")],
    withModel: false,
  });

  await assert.rejects(
    () => regenerateSessionTitle.call(runtime, { traceContext: TRACE }),
    /produced no title/,
  );
  assert.equal(updates.length, 0);
});

test("regenerateSessionTitle：模型返回空标题时抛错而不是静默留着旧标题", async () => {
  const { runtime, updates } = fakeRuntime({
    messages: [userMessage("m1", "有内容")],
    modelResult: { text: "   ", finishReason: "stop" },
  });

  await assert.rejects(
    () => regenerateSessionTitle.call(runtime, { traceContext: TRACE }),
    /produced no title/,
  );
  assert.equal(updates.length, 0);
});

test("regenerateSessionTitle：子会话与非 interactive 会话都拒绝", async () => {
  const child = fakeRuntime({
    messages: [userMessage("m1", "子会话内容")],
    session: { parentID: "sess-parent" },
  });
  await assert.rejects(
    () => regenerateSessionTitle.call(child.runtime, { traceContext: TRACE }),
    /interactive root session/,
  );
  assert.equal(child.updates.length, 0);

  const background = fakeRuntime({
    messages: [userMessage("m1", "后台会话内容")],
    session: { taskType: "background" },
  });
  await assert.rejects(
    () => regenerateSessionTitle.call(background.runtime, { traceContext: TRACE }),
    /interactive root session/,
  );
  assert.equal(background.updates.length, 0);
});

test("regenerateSessionTitle：短首条消息不被 10 字门槛挡住", async () => {
  const { runtime, updates } = fakeRuntime({ messages: [userMessage("m1", "hi")] });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.titleSource, "generated");
});

test("regenerateSessionTitle：首条 query 被编辑过也照常生成，不套用首轮的 rewind 守卫", async () => {
  // 首轮自动生成有一条「首条 query 被编辑过就跳过写回」的守卫（sidecar 与主消息并发，
  // 用户可能在 LLM 返回前改写了首条 query）。手动重生成不能套用它：素材是点击那一刻
  // 现取的，守卫一旦生效，这次点击就会静默什么都不做。
  const { runtime, updates } = fakeRuntime({
    messages: [userMessage("m1", "编辑后的第一条消息")],
    session: {
      revert: {
        kind: "conversation_rewind",
        targetMessageID: "m-old",
        keptMessageIDs: [],
      },
    } as Partial<SessionInfo>,
  });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.titleSource, "generated");
});

test("regenerateSessionTitle：不写 sessionTitleGenerationAttempted，不污染首轮自动生成", async () => {
  const { runtime, updates } = fakeRuntime({
    messages: [userMessage("m1", "内容足够长的首条消息")],
    titleGenerationAttempted: false,
  });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  // 该标记是首轮自动生成的私有一次性闸门；手动重生成若去写它，
  // 会让本会话此后再也拿不到首轮自动标题。
  assert.equal(runtime.sessionTitleGenerationAttempted, false);
});