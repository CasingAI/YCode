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

function fakeModel(result: FakeModelResult | (() => FakeModelResult), prompts?: unknown[]) {
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
    async generateText(request: unknown) {
      prompts?.push(request);
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
  const factorySelections: unknown[] = [];
  const debugEvents: string[] = [];
  const modelRequests: unknown[] = [];
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
    logger: {
      debug(_message: string, meta?: { event?: string }) {
        if (meta?.event) debugEvents.push(meta.event);
      },
      warn() {},
      info() {},
    },
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
    modelFactory: (input: { selection?: unknown }) => {
      factorySelections.push(input.selection);
      return fakeModel(
        options.modelResult ?? { text: '{"title":"重新生成的标题"}', finishReason: "stop" },
        modelRequests,
      );
    },
    getSessionModelSelection: () => (options.withModel === false ? undefined : SELECTION),
    createEvent: (type: string, payload: Record<string, unknown>) => ({ type, ...payload }),
    appendEvent: async (event: Record<string, unknown>) => {
      appended.push(event);
    },
    createModelStatusSink: () => undefined,
    extractToolCallsFromResult: () => [],
  } as unknown as AgentRuntimeInternal;

  return { runtime, updates, appended, factorySelections, debugEvents, modelRequests };
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
  // titleMessageID 记素材中最早的可见用户消息：末尾段收集后是 m3，不再是会话首条。
  assert.equal(update.titleMessageID, "m3");
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

test("regenerateSessionTitle：会话选择未绑定时显式失败（title.modelUnavailable），不换模型", async () => {
  // 冷恢复只绑定完整选择：会话历史模型被禁用后 getSessionModelSelection() 是 undefined。
  // 产品决策（2026-10-07）：不做静默回退——悄悄换模型生成标题超出用户预期；
  // 抛带 reasonCode 的领域错误，UI 弹模态说明原因。config.titleGeneration.modelSelection
  // 配置后同一会话即可恢复生成（优先级最高的钉模型口）。
  const { runtime, updates, factorySelections } = fakeRuntime({
    messages: [userMessage("m1", "历史模型已被禁用的老会话")],
    withModel: false,
  });

  await assert.rejects(
    () => regenerateSessionTitle.call(runtime, { traceContext: TRACE }),
    (error: unknown) => {
      assert.equal(
        (error as { reasonCode?: string }).reasonCode,
        "title.modelUnavailable",
      );
      assert.match((error as Error).message, /no usable model selection/);
      return true;
    },
  );
  // 没有借任何回退模型发请求。
  assert.equal(factorySelections.length, 0);
  assert.equal(updates.length, 0);
});

test("regenerateSessionTitle：配置了 titleGeneration.modelSelection 时会话未绑定也可生成", async () => {
  // config.titleGeneration?.modelSelection 优先于会话选择；有它就无需会话绑定。
  const PINNED: ModelSelection = {
    providerId: "pinned-provider",
    modelId: "pinned-model",
  } as ModelSelection;
  const { runtime, updates, factorySelections } = fakeRuntime({
    messages: [userMessage("m1", "历史模型已被禁用但配置了专用模型")],
    withModel: false,
  });
  (runtime as { config: { titleGeneration: { modelSelection: ModelSelection } } }).config
    .titleGeneration = { modelSelection: PINNED };

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  assert.deepEqual(factorySelections[0], PINNED);
});

test("regenerateSessionTitle：模型返回空标题时抛 title.emptyResult 而不是静默留着旧标题", async () => {
  const { runtime, updates } = fakeRuntime({
    messages: [userMessage("m1", "有内容")],
    modelResult: { text: "   ", finishReason: "stop" },
  });

  await assert.rejects(
    () => regenerateSessionTitle.call(runtime, { traceContext: TRACE }),
    (error: unknown) => {
      assert.equal((error as { reasonCode?: string }).reasonCode, "title.emptyResult");
      assert.match((error as Error).message, /produced no title/);
      return true;
    },
  );
  assert.equal(updates.length, 0);
});

test("regenerateSessionTitle：空会话抛 title.noMaterial", async () => {
  const { runtime } = fakeRuntime({ messages: [] });

  await assert.rejects(
    () => regenerateSessionTitle.call(runtime, { traceContext: TRACE }),
    (error: unknown) => {
      assert.equal((error as { reasonCode?: string }).reasonCode, "title.noMaterial");
      return true;
    },
  );
});

test("regenerateSessionTitle：素材取会话末尾段（与 History 一致），超预算时最早内容先被丢弃", async () => {
  // 老会话首条消息常是 plan 路径 +「执行计划」这类零信息量文本；几百轮之后素材
  // 必然超预算，此时必须优先保留**末尾**——会话「当前在做什么」由末尾段反映，
  // 同模型才能生成出与旧标题不同的有效标题。
  const longHead = "首条超长历史消息。".repeat(300); // ≈2700 字，单独超预算
  const { runtime, updates, modelRequests } = fakeRuntime({
    messages: [
      userMessage("m1", `${longHead} 执行计划`),
      assistantMessage("m2", "我先读取这个计划文件，了解要执行的内容。"),
      userMessage("m3", "排查任务列表分组拖拽后顺序不持久的问题"),
      assistantMessage("m4", "已定位到 groupOrder 写回时被覆盖，修复方案是改用单一所有者"),
    ],
  });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  // titleMessageID 记素材中最早的可见用户消息：末尾优先后被截到 m3。
  assert.equal(updates[0]!.titleMessageID, "m3");
  const prompt = JSON.stringify(modelRequests[0]);
  assert.ok(prompt.includes("分组拖拽"), "素材应包含末尾用户消息");
  assert.ok(prompt.includes("单一所有者"), "素材应包含末尾助手回复");
  assert.ok(!prompt.includes("执行计划"), "超预算后最早的内容不应进入素材");
});

test("regenerateSessionTitle：fork 任务（带 parentID）正常生成，不再按 parentID 判根", async () => {
  // 显式 fork 带 parent 却是任务列表可见主任务（task-list-session-membership.ts 的既有注释），
  // 按 parentID 拒绝会出现「菜单可见、后端必拒」的失败 toast——2026-10-07 桌面实测踩中。
  const { runtime, updates } = fakeRuntime({
    messages: [
      userMessage("m1", "排查两个 UI 元素的收起逻辑"),
      assistantMessage("m2", "定位到状态所有者分裂成了两处"),
    ],
    session: { parentID: "sess-parent", taskType: "fork" },
  });

  await regenerateSessionTitle.call(runtime, { traceContext: TRACE });

  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.title, "重新生成的标题");
  assert.equal(updates[0]!.titleSource, "generated");
});

test("regenerateSessionTitle：任务列表不可见的会话类型仍拒绝（防御性）", async () => {
  // subagent / 辅助对话 / workflow child 不在任务列表、菜单不可达，闸门仍要拒绝。
  const subagent = fakeRuntime({
    messages: [userMessage("m1", "子会话内容")],
    session: { parentID: "sess-parent", taskType: "subagent_child" },
  });
  await assert.rejects(
    () => regenerateSessionTitle.call(subagent.runtime, { traceContext: TRACE }),
    /task-list session/,
  );
  assert.equal(subagent.updates.length, 0);

  const sideChat = fakeRuntime({
    messages: [userMessage("m1", "辅助对话内容")],
    session: { taskType: "selection_side_chat" },
  });
  await assert.rejects(
    () => regenerateSessionTitle.call(sideChat.runtime, { traceContext: TRACE }),
    /task-list session/,
  );
  assert.equal(sideChat.updates.length, 0);
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