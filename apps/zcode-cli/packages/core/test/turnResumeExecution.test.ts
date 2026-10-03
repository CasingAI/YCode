// 同 turn 续跑的「执行期」行为契约（docs/specs/session-error-banner-continue.md §4.3）。
//
// turnResume.test.ts 只锁「定位失败轮」；这里锁真正跑起来的那条链，因为用户诉求里最硬的
// 两条不变量恰好都在执行期才成立：
//   1. 同一个 turn：turnId 原样复用、turnNumber 不递增、不发 TurnStarted（不新增 header）。
//   2. 模型无感：输入侧零写入（不落库 user prompt、不灌内存历史、不加 turnRequest 条目），
//      发给 provider 的前缀就是失败前那次请求的原样快照。
//
// 断言方式是「跑真实的 resumeFailedTurnCommand」，把 createTurnModel / turn loop /
// appendEvent 换成可观测的桩，其余（resolveFailedTurn、TurnMachine、事件构造、
// turnRequestState 装配、终态收口）走真实实现。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageId,
  MessageWithParts,
  SessionId,
  SessionStorePort,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { resumeFailedTurnCommand } from "../src/runtime/methods/turn-resume.js";

const SESSION_ID = "session-resume-exec" as SessionId;
const USER_MESSAGE_ID = "msg_user_failed_turn" as MessageId;
const RUNTIME_TURN_ID = "turn_runtime_failed" as TurnId;
const TRACE: TraceContext = { traceId: "trace-resume-exec" as TraceContext["traceId"] };

/** 失败轮的持久转录：一条 user + 一条带 error 的 assistant（anchor 指向 runtime turnId）。 */
function transcriptWithFailedTurn(): MessageWithParts[] {
  return [
    {
      info: {
        id: USER_MESSAGE_ID,
        sessionID: SESSION_ID,
        role: "user",
        time: { created: 1000 },
      },
      parts: [{ id: "prt_1", messageID: USER_MESSAGE_ID, sessionID: SESSION_ID, type: "text", text: "把目标会话恢复到失败态" }],
    } as unknown as MessageWithParts,
    {
      info: {
        id: "msg_assistant_failed" as MessageId,
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: USER_MESSAGE_ID,
        anchor: { turnId: RUNTIME_TURN_ID },
        time: { created: 1100, completed: 1200 },
        error: { name: "ModelError", data: { code: "model_rate_limited", message: "boom" } },
      },
      parts: [],
    } as unknown as MessageWithParts,
  ];
}

interface Observed {
  persistedPrompts: number;
  historyAdds: number;
  /** 续跑期间被写进内存历史的条目角色（用来证明没有 user 角色被注入）。 */
  historyRoles: string[];
  appendedEvents: Array<{ type: string; turnId?: string; payload: Record<string, unknown> }>;
  /** 发给 provider 的请求前缀条数（模型实际看到的历史）。 */
  /** provider 实际收到的消息前缀（证明模型看到的上下文）。 */
  providerRequests: unknown[];
  activeTurnIds: string[];
  turnNumberAtStart: number;
  finishedTurns: string[];
}

/**
 * 造一个可观测的 runtime。turn loop 用桩替掉：它只负责「把这次请求发给模型」，
 * 我们要锁的是续跑把什么喂给了它、以及外层有没有偷偷写输入。
 */
function observableRuntime(options: { turnNumber: number }): {
  runtime: AgentRuntimeInternal;
  observed: Observed;
} {
  const observed: Observed = {
    persistedPrompts: 0,
    historyAdds: 0,
    historyRoles: [],
    appendedEvents: [],
    providerRequests: [],
    activeTurnIds: [],
    turnNumberAtStart: options.turnNumber,
    finishedTurns: [],
  };
  // 失败前那次请求的原始前缀：冷恢复后 messageHistory 里剩下的东西。
  // 形状必须是真实 RuntimeMessageEntry（provider 请求直接吃这些条目）。
  const prefixSnapshot = [
    {
      id: "entry_u1",
      message: { role: "user", content: "把目标会话恢复到失败态" },
      metadata: {},
    },
    {
      id: "entry_a1",
      message: { role: "assistant", content: [{ type: "text", text: "处理中" }] },
      metadata: {},
    },
    {
      id: "entry_t1",
      message: { role: "user", content: [{ type: "tool-result", toolCallId: "tc1", output: { type: "text", text: "ok" } }] },
      metadata: {},
    },
  ];

  const runtime = {
    sessionId: SESSION_ID,
    turnNumber: options.turnNumber,
    branchGeneration: 7,
    rootTraceContext: TRACE,
    sessionStore: {
      messages: async () => transcriptWithFailedTurn(),
    } as unknown as SessionStorePort,
    // 任何输入侧写入都会被抓到 —— 这是「模型无感」的可观测形式。
    persistUserPrompt: async () => {
      observed.persistedPrompts += 1;
      throw new Error("续跑不得落库新的 user prompt");
    },
    persistSyntheticUserNoticeForSession: async () => {
      throw new Error("续跑不得写 model-only 通知");
    },
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => prefixSnapshot,
      addEntries: (entries: Array<{ message?: { role?: string } }> = []) => {
        observed.historyAdds += 1;
        for (const entry of entries) {
          observed.historyRoles.push(String(entry?.message?.role ?? "unknown"));
        }
      },
      addUser: () => {
        throw new Error("续跑不得往历史注入 user 条目");
      },
    },
    getSessionModelSelection: () => ({ modelId: "test-model", providerId: "test-provider" }),
    config: { taskType: "agent" },
    // 唯一需要伪造的模型接缝：createTurnModel → createRuntimeModel → runtime.modelFactory。
    // 换掉它之后，resolveFailedTurn / TurnMachine / 事件构造 / turnRequestState 装配 /
    // turnNumber 账本全部走真实实现。
    modelFactory: () => ({
      providerId: "test-provider",
      modelId: "test-model",
      displayName: "test-model",
      properties: { contextWindow: 200_000 },
      optionSpecs: { maxOutputTokens: { max: 64_000 } },
      options: {},
      bind() {
        return this;
      },
      generateText: async (request: { messages?: unknown }) => {
        observed.providerRequests.push(request?.messages);
        return { text: "续跑产出", usage: {}, finish: "stop" };
      },
      streamText: (request: { messages?: unknown }) => {
        observed.providerRequests.push(request?.messages);
        throw new Error("本用例不覆盖流式返回，只锁请求内容");
      },
    }),
    ensureContextInitialized: async () => {},
    // —— 模型步骤需要的运行时面（无副作用桩）——
    logModelRequestSteeringContext: () => {},
    // 没有待处理的 guide 输入（本轮由「继续」发起，不是用户 steer）。
    hasInlineGuidePendingInput: () => false,
    runStopHooks: async () => undefined,
    shouldContinueAfterStopHooks: () => false,
    fallbackPendingGuidesToQueue: async () => {},
    injectHookAdditionalContextIntoMessageHistory: () => undefined,
    takeInlineGuidePendingInput: () => undefined,
    // 本轮没有文件改动；给它一个空 Map（真实值是 Map，读 .size）。
    currentTurnFileChanges: new Map(),
    extractToolCallsFromResult: () => [],
    reactiveCompactAfterContextExceeded: async () => false,
    persistAssistantMessage: async () => ({}),
    persistPart: async () => {},
    runModelTextRequest: async (request: { messages?: unknown }) => {
      // 真正的「模型视角」入口：这里看到的就是模型能看到的全部上下文。
      observed.providerRequests.push(request?.messages);
      return { text: "续跑产出", parts: [], finish: "stop", usage: {} };
    },
    // 记录 provider 实际收到的请求前缀 —— 「模型无感」的直接证据。
    agentTelemetry: {
      step: ({ stepId }: { stepId: string }) => ({
        run: async (fn: () => Promise<unknown>) => fn(),
        finishCompleted: () => {},
        finishFailed: () => {},
      }),
    },
    // —— turn loop 需要的运行时面（全部无副作用的桩）——
    microcompactIfNeeded: async () => false,
    autoCompactIfNeeded: async () => false,
    readSessionTodosForContext: async () => "",
    drainPendingRuntimeCommandsForActiveLoop: async () => [],
    getMode: () => "yolo",
    getTools: () => [],
    initializeMcp: async () => {},
    beginActiveTurn: (turnId: string) => {
      observed.activeTurnIds.push(turnId);
      return { turnId };
    },
    finishActiveTurn: (activeTurn: { turnId: string }) => {
      observed.finishedTurns.push(activeTurn.turnId);
    },
    createEvent: (type: string, payload: Record<string, unknown>, traceContext: TraceContext) => ({
      type,
      payload,
      sessionId: SESSION_ID,
      turnId: (traceContext as { turnId?: string }).turnId,
      timestamp: new Date(2000),
      sequenceNumber: observed.appendedEvents.length + 1,
    }),
    appendEvent: async (event: { type: string; turnId?: string; payload: Record<string, unknown> }) => {
      observed.appendedEvents.push({
        type: event.type,
        turnId: event.turnId as string | undefined,
        payload: event.payload,
      });
    },
    rebuildProjection: async () => {},
    logger: undefined,
  } as unknown as AgentRuntimeInternal;

  return { runtime, observed };
}

/**
 * 跑真实的 resumeFailedTurnCommand。整轮必须跑完（不靠"起跑期就断言"蒙混），
 * 因为「同一 turn 跑到底」正是要证明的事。
 */
async function runResume(runtime: AgentRuntimeInternal): Promise<void> {
  const started = { promise: Promise.resolve(), resolve: () => {} };
  await resumeFailedTurnCommand.call(
    runtime,
    USER_MESSAGE_ID,
    "input-resume-1",
    TRACE,
    new AbortController().signal,
    started as never,
  );
}

test("同 turn 续跑：复用 turnId、不发 TurnStarted、输入侧零写入、模型前缀原样", async () => {
  const { runtime, observed } = observableRuntime({ turnNumber: 42 });

  // 整轮跑完，不抛 —— 说明失败轮确实被原地复活并正常收口。
  await runResume(runtime);

  // —— 不变量 1：输入侧零写入（模型无从感知发生过网络问题）——
  assert.equal(observed.persistedPrompts, 0, "续跑不得以用户身份落库任何消息");
  // 允许追加模型本轮自己的产出（assistant / tool 结果），但绝不允许出现 user 角色：
  // 只要没有 user 条目，provider 请求里就不可能多出一条"以用户身份"的消息。
  assert.equal(
    observed.historyRoles.includes("user"),
    false,
    `续跑不得往 messageHistory 注入 user 条目，实际写入角色：${observed.historyRoles.join(",")}`,
  );

  // —— 不变量 2：同一个 turn ——
  assert.deepEqual(
    observed.activeTurnIds,
    [String(RUNTIME_TURN_ID)],
    "必须复用失败轮的 runtime turnId",
  );
  assert.deepEqual(
    observed.finishedTurns,
    [String(RUNTIME_TURN_ID)],
    "收尾必须关在同一轮上",
  );

  // —— 不变量 3：不新增轮次 ——
  assert.equal(
    observed.appendedEvents.some((e) => e.type === SessionEventType.TurnStarted),
    false,
    "续跑不得发 TurnStarted —— 投影会把它当成新增一行 turnHeader",
  );
  assert.equal(runtime.turnNumber, 42, "同 turn 续跑不得递增 turnNumber");

  // —— 事件序列：TurnResumed 在前（横幅先消失），TurnComplete 收口 ——
  const types = observed.appendedEvents.map((e) => e.type);
  const resumedIndex = types.indexOf(SessionEventType.TurnResumed);
  const completeIndex = types.indexOf(SessionEventType.TurnComplete);
  assert.ok(resumedIndex >= 0, "必须发出 TurnResumed");
  assert.ok(completeIndex > resumedIndex, "TurnResumed 必须先于 TurnComplete");
  assert.equal(
    types.filter((t) => t === SessionEventType.TurnComplete).length,
    1,
    "整轮只收口一次",
  );
  const resumed = observed.appendedEvents[resumedIndex]!;
  assert.equal(resumed.turnId, String(RUNTIME_TURN_ID), "TurnResumed 归属失败轮");
  assert.equal(
    resumed.payload.userMessageId,
    String(USER_MESSAGE_ID),
    "回带该轮 user 消息 id，投影据此对账",
  );

  // —— 模型视角：请求前缀就是失败前那次请求的原样快照 ——
  assert.equal(observed.providerRequests.length, 1, "续跑只应发一次模型请求");
  const request = observed.providerRequests[0] as Array<{ role?: string; content?: unknown }>;
  // 前三条 = 失败前那次请求的原样快照；第四条是每轮都会附带的 system 模式提示，
  // 与「继续」无关（正常发消息的轮次也有）。关键是没有多出任何 user 角色消息。
  assert.equal(request.length, 4, "模型上下文 = 原样前缀 3 条 + 每轮固定的 system 提示");
  assert.deepEqual(
    request.slice(0, 3).map((m) => m.role),
    ["user", "assistant", "user"],
    "失败前的上下文角色序列原样保留：没有插入任何新 user 消息",
  );
  assert.equal(request[3]?.role, "system");
  assert.equal(
    request.filter((m) => m.role === "user").length,
    2,
    "user 角色消息数必须与失败前一致（第 3 条是 tool-result 载体，不是新输入）",
  );
  // 失败那条 assistant 已被 hydrator 丢弃，所以模型看不到错误，也看不到"重试"痕迹。
  assert.equal(
    request.some((m) => JSON.stringify(m).includes("model_rate_limited")),
    false,
    "模型上下文中不得出现网络错误",
  );
  assert.equal(
    request.some((m) => JSON.stringify(m).includes("继续") || JSON.stringify(m).includes("retry")),
    false,
    "模型上下文中不得出现任何以用户身份插入的重试消息",
  );
});

test("起跑 ack 先于整轮结束：TurnResumed 落库即 resolve started", async () => {
  const { runtime, observed } = observableRuntime({ turnNumber: 7 });
  let startedResolved = false;
  const started = {
    promise: Promise.resolve(),
    resolve: () => {
      startedResolved = true;
    },
  } as never;

  await resumeFailedTurnCommand.call(
    runtime,
    USER_MESSAGE_ID,
    "input-resume-2",
    TRACE,
    new AbortController().signal,
    started,
  );

  // 整轮已跑完，ack 必须在其中；且 ack 那一刻 TurnResumed 已经落库。
  assert.equal(startedResolved, true, "TurnResumed 落库后必须 resolve 起跑信号");
  const types = observed.appendedEvents.map((e) => e.type);
  assert.ok(types.includes(SessionEventType.TurnResumed));
  assert.ok(types.includes(SessionEventType.TurnComplete));
});

test("转录里定位不到失败轮 → 明确报错，不静默、不改动任何输入", async () => {
  const { runtime, observed } = observableRuntime({ turnNumber: 9 });
  await assert.rejects(
    () =>
      resumeFailedTurnCommand.call(
        runtime,
        "msg_not_a_failed_turn",
        "input-resume-3",
        TRACE,
        new AbortController().signal,
        { promise: Promise.resolve(), resolve: () => {} } as never,
      ),
    /No failed turn to resume/u,
  );
  assert.equal(observed.persistedPrompts, 0);
  assert.equal(
    observed.appendedEvents.some((e) => e.type === SessionEventType.TurnResumed),
    false,
    "定位失败时不得发出 TurnResumed —— 否则横幅会假消失",
  );
});
