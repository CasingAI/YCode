import assert from "node:assert/strict";
import test from "node:test";
// handlers/index.js 必须先进来：goal-compact → session-flow → prompt-turn → session-residency
// 回到 handlers/index 构成既有循环，先导入 barrel 才能让 handler 表在被 spread 前完成初始化。
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import {
  AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX,
  aiHistorySearchHandlers,
  assertNotAiHistorySearchSession,
  V4AiHistorySearchSessionRestrictedCommandError,
} from "../src/zcode-protocol-v4/commands/handlers/ai-history-search.js";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { prepareAiHistorySearchModelGroupAdmission } from "../src/zcode-protocol-v4/commands/handlers/model-group-admission.js";
import { V4InputAdmissionRejectedError } from "../src/zcode-protocol-v4/commands/handlers/session-flow.js";
import { runAiHistorySearchTurn } from "../src/zcode-protocol/v4-bridge.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

// 命令中心一次性 AI 历史搜索（docs/specs/command-center-ai-history-search.md）：
// 宿主能力缺席时 start 明确失败（UI 显示「运行时不可用」，不冒充关键词结果）；
// cancel 无能力时幂等成功（无隐藏会话可回收）；隐藏会话拒绝改写类命令。

function startEnvelope(query = "上次改鉴权的结论") {
  return {
    commandId: "cmd-ai-search-1",
    sessionId: null,
    type: "startAiHistorySearch",
    payload: { workspaceId: "/tmp/proj", query },
    issuedAt: Date.now(),
  } as never;
}

function cancelEnvelope(searchSessionId = "sess_ai_search_abc") {
  return {
    commandId: "cmd-ai-search-cancel-1",
    // 工作区级命令：信封 sessionId 为 null，路由键在 payload.searchSessionId。
    sessionId: null,
    type: "cancelAiHistorySearch",
    payload: { searchSessionId },
    issuedAt: Date.now(),
  } as never;
}

test("startAiHistorySearch：宿主无能力时抛 unsupported 失败码", async () => {
  const host = { getRecord: () => undefined };
  await assert.rejects(
    () => aiHistorySearchHandlers.startAiHistorySearch(host as never, startEnvelope()),
    (error: unknown) =>
      error instanceof Error &&
      (error as { reasonCode?: string }).reasonCode ===
        `${AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX}unsupported`,
  );
});

test("startAiHistorySearch：宿主有能力时回隐藏会话 id", async () => {
  let seen: unknown;
  const host = {
    getRecord: () => undefined,
    startAiHistorySearch: async (input: unknown) => {
      seen = input;
      return { searchSessionId: "sess_ai_search_abc" };
    },
  };
  const result = await aiHistorySearchHandlers.startAiHistorySearch(host as never, startEnvelope());
  assert.deepEqual(result, { type: "startAiHistorySearch", sessionId: "sess_ai_search_abc" });
  assert.deepEqual(seen, {
    workspaceId: "/tmp/proj",
    query: "上次改鉴权的结论",
    sourceCommandId: "cmd-ai-search-1",
  });
});

test("startAiHistorySearch：model 随命令透传宿主（缺席时不带字段）", async () => {
  let seen: unknown;
  const host = {
    getRecord: () => undefined,
    startAiHistorySearch: async (input: unknown) => {
      seen = input;
      return { searchSessionId: "sess_ai_search_model" };
    },
  };
  const withModel = await aiHistorySearchHandlers.startAiHistorySearch(
    host as never,
    {
      commandId: "cmd-ai-search-model-1",
      sessionId: null,
      type: "startAiHistorySearch",
      payload: {
        workspaceId: "/tmp/proj",
        query: "结论",
        model: { providerId: "zai", modelId: "glm-5", options: { reasoningLevel: "high" } },
      },
      issuedAt: Date.now(),
    } as never,
  );
  assert.deepEqual(withModel, { type: "startAiHistorySearch", sessionId: "sess_ai_search_model" });
  assert.deepEqual(seen, {
    workspaceId: "/tmp/proj",
    query: "结论",
    model: { providerId: "zai", modelId: "glm-5", options: { reasoningLevel: "high" } },
    sourceCommandId: "cmd-ai-search-model-1",
  });

  let seenLegacy: unknown;
  const legacyHost = {
    getRecord: () => undefined,
    startAiHistorySearch: async (input: unknown) => {
      seenLegacy = input;
      return { searchSessionId: "sess_ai_search_legacy" };
    },
  };
  await aiHistorySearchHandlers.startAiHistorySearch(legacyHost as never, startEnvelope());
  assert.deepEqual(seenLegacy, {
    workspaceId: "/tmp/proj",
    query: "上次改鉴权的结论",
    sourceCommandId: "cmd-ai-search-1",
  });
});
test("startAiHistorySearch：modelGroupIntent 随命令透传宿主，不与 model 双写", async () => {
  let seen: unknown;
  const host = {
    getRecord: () => undefined,
    startAiHistorySearch: async (input: unknown) => {
      seen = input;
      return { searchSessionId: "sess_ai_search_group" };
    },
  };
  const groupIntent = { groupId: "model-group:fast", groupNameSnapshot: "快速模型" };
  const result = await aiHistorySearchHandlers.startAiHistorySearch(
    host as never,
    {
      commandId: "cmd-ai-search-group-1",
      sessionId: null,
      type: "startAiHistorySearch",
      payload: { workspaceId: "/tmp/proj", query: "结论", modelGroupIntent: groupIntent },
      issuedAt: Date.now(),
    } as never,
  );
  assert.deepEqual(result, { type: "startAiHistorySearch", sessionId: "sess_ai_search_group" });
  assert.deepEqual(seen, {
    workspaceId: "/tmp/proj",
    query: "结论",
    modelGroupIntent: groupIntent,
    sourceCommandId: "cmd-ai-search-group-1",
  });
});

// 组 admission 的宿主替身：只模拟 decide/commit 需要的 app 面（组名单 + 目录 + runtime 写口）。
interface GroupRecordHarness {
  record: V4SessionRecordView;
  calls: string[];
  closed: number;
  modelSelection:
    | { providerId: string; modelId: string; options?: { reasoningLevel?: string } }
    | undefined;
  groupState: unknown;
  emitted: Array<{ effectiveReasoningLevel?: string; previousModelSelection: unknown }>;
}

function buildGroupAdmissionRecord(options: {
  groups: Array<{
    groupId: string;
    name: string;
    enabled?: boolean;
    memberOrder: Array<{ providerId: string; modelId: string; reasoningLevel?: string }>;
  }>;
  models: Array<{ providerId: string; modelId: string; levels: string[]; defaultLevel?: string }>;
}): GroupRecordHarness {
  const calls: string[] = [];
  const state: GroupRecordHarness = {
    calls,
    closed: 0,
    groupState: undefined,
    modelSelection: undefined,
    emitted: [],
    record: {
      app: {
        sessionId: "sess_ai_search_group",
        listModelGroups: async () => options.groups,
        listModels: () =>
          options.models.map((model) => ({
            ref: { providerId: model.providerId, modelId: model.modelId },
            reasoning: {
              levels: model.levels.map((value) => ({ value })),
              ...(model.defaultLevel ? { defaultLevel: model.defaultLevel } : {}),
            },
          })),
        runtime: {
          getSessionModelGroupState: () => state.groupState,
          getSessionModelSelection: () => state.modelSelection,
          applySessionModelGroupState: async (next: unknown) => {
            state.groupState = next;
            calls.push("groupState");
          },
          setSessionModelSelection: (selection: {
            providerId: string;
            modelId: string;
            options?: { reasoningLevel?: string };
          }) => {
            state.modelSelection = selection;
            calls.push(
              `set:${selection.providerId}/${selection.modelId}:${selection.options?.reasoningLevel ?? "-"}`,
            );
          },
          emitModelSelected: async (payload: {
            effectiveReasoningLevel?: string;
            previousModelSelection: unknown;
          }) => {
            state.emitted.push(payload);
            calls.push("modelSelected");
          },
        },
      },
      traceContext: { queryId: "query-ai-search" },
    } as unknown as V4SessionRecordView,
  };
  return state;
}

const AI_SEARCH_GROUP_INTENT = {
  groupId: "model-group:fast",
  groupNameSnapshot: "快速模型",
};

function admitAiSearchGroup(harness: GroupRecordHarness, intent = AI_SEARCH_GROUP_INTENT) {
  return prepareAiHistorySearchModelGroupAdmission(harness.record, intent, {
    closeHiddenSession: async () => {
      harness.closed += 1;
      harness.calls.push("close");
    },
  });
}

test("AI 搜索组 admission：实际成员压到最低成本档，写入会话选择与组状态", async () => {
  const harness = buildGroupAdmissionRecord({
    groups: [
      {
        groupId: AI_SEARCH_GROUP_INTENT.groupId,
        name: "快速模型",
        // 成员绑定 high；搜索必须按该成员实际支持表压到第一项 low，而不是沿用绑定档。
        memberOrder: [{ providerId: "zcode", modelId: "glm-5", reasoningLevel: "high" }],
      },
    ],
    models: [
      { providerId: "zcode", modelId: "glm-5", levels: ["low", "high"], defaultLevel: "high" },
    ],
  });

  const outcome = await admitAiSearchGroup(harness);

  assert.equal(outcome.needsPin, true);
  assert.deepEqual(outcome.selection, {
    providerId: "zcode",
    modelId: "glm-5",
    options: { reasoningLevel: "low" },
  });
  assert.deepEqual(harness.modelSelection, outcome.selection);
  assert.deepEqual(harness.groupState, {
    intent: AI_SEARCH_GROUP_INTENT,
    pickSeed: "sess_ai_search_group",
  });
  assert.equal(harness.emitted[0]?.effectiveReasoningLevel, "low");
  assert.deepEqual(harness.calls, ["groupState", "set:zcode/glm-5:low", "modelSelected"]);
  assert.equal(harness.closed, 0);
});

test("AI 搜索组 admission：关闭语义档优先，保留配置原值", async () => {
  const harness = buildGroupAdmissionRecord({
    groups: [
      {
        groupId: AI_SEARCH_GROUP_INTENT.groupId,
        name: "快速模型",
        memberOrder: [{ providerId: "zcode", modelId: "glm-5" }],
      },
    ],
    models: [
      {
        providerId: "zcode",
        modelId: "glm-5",
        levels: ["high", "OFF", "low"],
        defaultLevel: "high",
      },
    ],
  });

  const outcome = await admitAiSearchGroup(harness);
  assert.deepEqual(outcome.selection.options, { reasoningLevel: "OFF" });
  assert.equal(harness.emitted[0]?.effectiveReasoningLevel, "OFF");
});

test("AI 搜索组 admission：档位表为空时不编档位", async () => {
  const harness = buildGroupAdmissionRecord({
    groups: [
      {
        groupId: AI_SEARCH_GROUP_INTENT.groupId,
        name: "快速模型",
        memberOrder: [{ providerId: "zcode", modelId: "glm-5" }],
      },
    ],
    models: [{ providerId: "zcode", modelId: "glm-5", levels: [] }],
  });

  const outcome = await admitAiSearchGroup(harness);
  assert.deepEqual(outcome.selection, { providerId: "zcode", modelId: "glm-5" });
  assert.equal(outcome.selection.options, undefined);
  assert.equal(harness.emitted[0]?.effectiveReasoningLevel, undefined);
});

test("AI 搜索组 admission：组已删拒绝并回收隐藏会话，不写模型/组状态", async () => {
  const harness = buildGroupAdmissionRecord({
    groups: [],
    models: [{ providerId: "zcode", modelId: "glm-5", levels: ["low"] }],
  });

  await assert.rejects(
    admitAiSearchGroup(harness),
    (error: unknown) =>
      error instanceof V4InputAdmissionRejectedError &&
      error.reasonCode === "modelGroup.deleted" &&
      /模型组「快速模型」已删除/.test(error.message),
  );
  assert.equal(harness.closed, 1);
  assert.deepEqual(harness.calls, ["close"]);
  assert.equal(harness.modelSelection, undefined);
  assert.equal(harness.groupState, undefined);
  assert.equal(harness.emitted.length, 0);
});

test("AI 搜索组 admission：无可用成员拒绝并回收隐藏会话", async () => {
  const harness = buildGroupAdmissionRecord({
    groups: [
      {
        groupId: AI_SEARCH_GROUP_INTENT.groupId,
        name: "快速模型",
        memberOrder: [{ providerId: "zcode", modelId: "glm-5" }],
      },
    ],
    models: [],
  });

  await assert.rejects(
    admitAiSearchGroup(harness),
    (error: unknown) =>
      error instanceof V4InputAdmissionRejectedError && error.reasonCode === "modelGroup.noMembers",
  );
  assert.equal(harness.closed, 1);
  assert.deepEqual(harness.calls, ["close"]);
  assert.equal(harness.modelSelection, undefined);
});

test("AI 搜索组 admission：停用组即使成员可解析也拒绝并回收隐藏会话", async () => {
  const harness = buildGroupAdmissionRecord({
    groups: [
      {
        groupId: AI_SEARCH_GROUP_INTENT.groupId,
        name: "快速模型",
        enabled: false,
        memberOrder: [{ providerId: "zcode", modelId: "glm-5" }],
      },
    ],
    models: [{ providerId: "zcode", modelId: "glm-5", levels: ["low"] }],
  });

  await assert.rejects(
    admitAiSearchGroup(harness),
    (error: unknown) =>
      error instanceof V4InputAdmissionRejectedError &&
      error.reasonCode === "modelGroup.noMembers" &&
      /模型组「快速模型」没有可用模型/.test(error.message),
  );
  assert.equal(harness.closed, 1);
  assert.deepEqual(harness.calls, ["close"]);
  assert.equal(harness.modelSelection, undefined);
});

test("cancelAiHistorySearch：宿主无能力时幂等成功", async () => {
  const host = { getRecord: () => undefined };
  const result = await aiHistorySearchHandlers.cancelAiHistorySearch(
    host as never,
    cancelEnvelope(),
  );
  assert.equal(result, undefined);
});

test("cancelAiHistorySearch：宿主有能力时透传隐藏会话 id", async () => {
  let seen: string | undefined;
  const host = {
    getRecord: () => undefined,
    cancelAiHistorySearch: async (searchSessionId: string) => {
      seen = searchSessionId;
    },
  };
  const result = await aiHistorySearchHandlers.cancelAiHistorySearch(
    host as never,
    cancelEnvelope(),
  );
  assert.equal(result, undefined);
  assert.equal(seen, "sess_ai_search_abc");
});

test("ai_history_search 会话拒绝改写类命令，普通会话放行", () => {
  const hiddenHost = {
    getRecord: (sessionId: string) =>
      sessionId === "sess_ai_search_abc" ? { taskType: "ai_history_search" } : undefined,
  } as never;
  assert.throws(
    () => assertNotAiHistorySearchSession(hiddenHost, "sess_ai_search_abc", "sendText"),
    V4AiHistorySearchSessionRestrictedCommandError,
  );

  const normalHost = {
    getRecord: () => ({ taskType: "interactive" }),
  } as never;
  assert.doesNotThrow(() => assertNotAiHistorySearchSession(normalHost, "sess_main", "sendText"));
  assert.doesNotThrow(() => assertNotAiHistorySearchSession(hiddenHost, null, "sendText"));
});

test("inbox：工作区级 AI 搜索命令（sessionId null）进入 admission，不判 sessionNotFound", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "log-epoch-1",
  });
  // UI 实际发送的 start 信封：sessionId null + workspaceId/query payload。
  const started = await inbox.handle({
    commandId: "cmd-ai-search-inbox-1",
    clientId: "client-test",
    sessionId: null,
    type: "startAiHistorySearch",
    payload: { workspaceId: "/tmp/proj", query: "侧边栏改版" },
    issuedAt: Date.now(),
  });
  assert.equal(started.kind, "execute");
  if (started.kind === "execute") started.settle({ status: "accepted" });

  const cancelled = await inbox.handle({
    commandId: "cmd-ai-search-inbox-2",
    clientId: "client-test",
    sessionId: null,
    type: "cancelAiHistorySearch",
    payload: { searchSessionId: "sess_ai_search_abc" },
    issuedAt: Date.now(),
  });
  assert.equal(cancelled.kind, "execute");
  if (cancelled.kind === "execute") cancelled.settle({ status: "accepted" });
});

test("inbox：非工作区级命令仍拒绝空会话（sendText + sessionId null → sessionNotFound）", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "log-epoch-1",
  });
  const outcome = await inbox.handle({
    commandId: "cmd-ai-search-inbox-3",
    clientId: "client-test",
    sessionId: null,
    type: "sendText",
    payload: { text: "hello" },
    issuedAt: Date.now(),
  });
  assert.equal(outcome.kind, "ack");
  if (outcome.kind === "ack") {
    assert.equal(outcome.ack.status, "rejected");
    assert.equal(outcome.ack.reasonCode, "proto.sessionNotFound");
  }
});

test("网关全链路：截图场景复现——start 空会话信封不再 sessionNotFound，正常 accepted", async () => {
  // 真实执行器 + 真实 ai-history-search handler，只把宿主能力换成测试替身。
  // 这条链路 = UI 发出的信封 → gateway.handleCommand → inbox → executor → handler。
  const executor = new V4CommandExecutor({
    getRecord: () => undefined,
    startAiHistorySearch: async () => ({ searchSessionId: "sess_ai_search_e2e" }),
  } as never);
  const gateway = new ConversationV4Gateway(
    {
      sessionExists: () => false,
      emitWireFrame: () => {},
      executeCommand: (envelope, admission) => executor.execute(envelope, admission),
    } as never,
    { now: () => Date.now(), createLogEpoch: () => "ai-search-epoch" },
  );

  const ack = await gateway.handleCommand({
    commandId: "cmd-ai-search-gateway-1",
    clientId: "client-test",
    sessionId: null,
    type: "startAiHistorySearch",
    payload: { workspaceId: "/tmp/proj", query: "侧边栏改版" },
    issuedAt: Date.now(),
  });

  assert.notEqual(ack.reasonCode, "proto.sessionNotFound");
  assert.equal(ack.status, "accepted");
  assert.deepEqual(ack.result, {
    type: "startAiHistorySearch",
    sessionId: "sess_ai_search_e2e",
  });
});

test("网关全链路：组 admission 失败保留 modelGroup.* reasonCode 并回收隐藏会话", async () => {
  const harness = buildGroupAdmissionRecord({ groups: [], models: [] });
  const executor = new V4CommandExecutor({
    getRecord: () => undefined,
    startAiHistorySearch: async (input: {
      modelGroupIntent: { groupId: string; groupNameSnapshot: string };
    }) => {
      await admitAiSearchGroup(harness, input.modelGroupIntent);
      return { searchSessionId: "sess_ai_search_group" };
    },
  } as unknown as V4CommandCoreHost);
  const gateway = new ConversationV4Gateway(
    {
      sessionExists: () => false,
      emitWireFrame: () => {},
      executeCommand: (envelope, admission) => executor.execute(envelope, admission),
    } as never,
    { now: () => Date.now(), createLogEpoch: () => "ai-search-group-epoch" },
  );

  const ack = await gateway.handleCommand({
    commandId: "cmd-ai-search-group-fail",
    clientId: "client-test",
    sessionId: null,
    type: "startAiHistorySearch",
    payload: {
      workspaceId: "/tmp/proj",
      query: "结论",
      modelGroupIntent: AI_SEARCH_GROUP_INTENT,
    },
    issuedAt: Date.now(),
  });

  assert.equal(ack.status, "failed");
  assert.equal(ack.reasonCode, "modelGroup.deleted");
  assert.match(ack.message ?? "", /模型组「快速模型」已删除/);
  assert.equal(harness.closed, 1);
});

// 真实启动编排：直接驱动 coreHost.startAiHistorySearch 的唯一调用点
// runAiHistorySearchTurn，只把隐藏会话创建与宿主注册表换成替身；admission、startPromptTurn
// 与终态 flush/close 都是生产实现。证明组失败不启动 turn、成功按最低档启动、
// completion 后才回收，且重复 cleanup 幂等只生效一次。
interface AiSearchStartHarness {
  context: ZCodeProtocolAgentServerContext;
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  order: string[];
  closeCalls: string[];
  flushCalls: string[];
  sendInputTexts: string[];
  sentSelections: unknown[];
  completion: { resolve(): void; reject(error: unknown): void };
}

function buildAiSearchStartHarness(options: {
  groups: Array<{
    groupId: string;
    name: string;
    enabled?: boolean;
    memberOrder: Array<{ providerId: string; modelId: string; reasoningLevel?: string }>;
  }>;
  models: Array<{ providerId: string; modelId: string; levels: string[]; defaultLevel?: string }>;
  sendInput: "started" | "throw";
}): AiSearchStartHarness {
  const admission = buildGroupAdmissionRecord({
    groups: options.groups,
    models: options.models,
  });
  const order: string[] = [];
  const closeCalls: string[] = [];
  const flushCalls: string[] = [];
  const sendInputTexts: string[] = [];
  const sentSelections: unknown[] = [];
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const record = admission.record;
  record.taskType = "ai_history_search";
  record.persistence = "deferred";
  const app = record.app as unknown as {
    sendInput: (input: { text: string }, options?: unknown) => Promise<unknown>;
    runtime: { getSessionModelSelection(): unknown };
  };
  app.sendInput = async (input) => {
    order.push("sendInput");
    sendInputTexts.push(input.text);
    // turn 启动那一刻会话必须已经是 admission 提交后的最低档选择。
    sentSelections.push(app.runtime.getSessionModelSelection());
    if (options.sendInput === "throw") throw new Error("turn boot failed");
    return { kind: "started" as const, completion };
  };
  const sessions = new Map<string, unknown>([[record.app.sessionId, record]]);
  const context = {
    sessions,
    v4Gateway: {
      conversationSubscriptionIds: (sessionId: string) =>
        sessionId === record.app.sessionId ? ["sub-ai-search"] : [],
      flushNow: (subscriptionId: string) => {
        flushCalls.push(subscriptionId);
        order.push("flush");
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  const closeSession = async (sessionId: string) => {
    closeCalls.push(sessionId);
    order.push("close");
    // 与 coreHost.closeSession 相同的注册表摘除语义，重复 close 在会话已不存在时 no-op。
    sessions.delete(sessionId);
  };
  const host = {
    getRecord: (sessionId: string) => sessions.get(sessionId),
    closeSession,
  } as unknown as V4CommandCoreHost;
  return {
    context,
    host,
    record,
    order,
    closeCalls,
    flushCalls,
    sendInputTexts,
    sentSelections,
    completion: { resolve: resolveCompletion, reject: rejectCompletion },
  };
}

const AI_SEARCH_START_INPUT = {
  query: "结论",
  modelGroupIntent: AI_SEARCH_GROUP_INTENT,
  sourceCommandId: "cmd-ai-search-start-orchestration",
};

test("AI 搜索真实启动编排：组已删 → turn 未启动，隐藏会话经既有 close 回收一次", async () => {
  const harness = buildAiSearchStartHarness({ groups: [], models: [], sendInput: "started" });

  await assert.rejects(
    runAiHistorySearchTurn(harness.context, harness.host, harness.record, AI_SEARCH_START_INPUT),
    (error: unknown) =>
      error instanceof V4InputAdmissionRejectedError && error.reasonCode === "modelGroup.deleted",
  );

  assert.deepEqual(harness.sendInputTexts, []);
  assert.deepEqual(harness.closeCalls, ["sess_ai_search_group"]);
  assert.deepEqual(harness.order, ["close"]);
  assert.equal(harness.context.sessions.size, 0);
});

test("AI 搜索真实启动编排：组成功以最低档启动 turn，completion 后先 flush 再 close", async () => {
  const harness = buildAiSearchStartHarness({
    groups: [
      {
        groupId: AI_SEARCH_GROUP_INTENT.groupId,
        name: "快速模型",
        memberOrder: [{ providerId: "zcode", modelId: "glm-5", reasoningLevel: "high" }],
      },
    ],
    models: [
      { providerId: "zcode", modelId: "glm-5", levels: ["low", "high"], defaultLevel: "high" },
    ],
    sendInput: "started",
  });

  const started = await runAiHistorySearchTurn(
    harness.context,
    harness.host,
    harness.record,
    AI_SEARCH_START_INPUT,
  );

  assert.deepEqual(started, { searchSessionId: "sess_ai_search_group" });
  assert.equal(harness.sendInputTexts.length, 1);
  assert.match(harness.sendInputTexts[0] ?? "", /结论/);
  assert.deepEqual(harness.sentSelections, [
    { providerId: "zcode", modelId: "glm-5", options: { reasoningLevel: "low" } },
  ]);
  // turn 仍在运行时不回收，浮层还要读投影。
  assert.deepEqual(harness.closeCalls, []);

  harness.completion.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.flushCalls, ["sub-ai-search"]);
  assert.deepEqual(harness.order, ["sendInput", "flush", "close"]);
  assert.deepEqual(harness.closeCalls, ["sess_ai_search_group"]);
  assert.equal(harness.context.sessions.size, 0);
});

test("AI 搜索真实启动编排：turn 启动抛错仍回收隐藏会话", async () => {
  const harness = buildAiSearchStartHarness({
    groups: [
      {
        groupId: AI_SEARCH_GROUP_INTENT.groupId,
        name: "快速模型",
        memberOrder: [{ providerId: "zcode", modelId: "glm-5" }],
      },
    ],
    models: [{ providerId: "zcode", modelId: "glm-5", levels: ["low"] }],
    sendInput: "throw",
  });

  await assert.rejects(
    runAiHistorySearchTurn(harness.context, harness.host, harness.record, AI_SEARCH_START_INPUT),
    (error: unknown) => error instanceof Error && error.message === "turn boot failed",
  );

  assert.deepEqual(harness.order, ["sendInput", "close"]);
  assert.deepEqual(harness.closeCalls, ["sess_ai_search_group"]);
  assert.deepEqual(harness.flushCalls, []);
  assert.equal(harness.context.sessions.size, 0);
});
