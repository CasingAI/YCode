// 侧栏计划描边在流式响应边界上的回归：网关不能跳过所有 ModelStreaming，
// 否则「后续响应的第一个 text/reasoning 事件」不会让列表摘要重新派生，
// 描边要等到 TurnComplete 才消失（用户看到的是一整个后续响应期间的错描边）。
//
// 这里走真实 ConversationV4Gateway → ConversationTopicPublisher → SessionsIndexPublisher，
// 同时订阅 desktop-continuous 与 web-remote-replayable，验证两档拿到的最终摘要同源。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  hasPlanCardInLastAssistantResponse,
  sessionsIndexTopic,
  type RoutedTopicWireFrame,
  type SessionSummary,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import type { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import type { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";

const WORKSPACE_ID = "/repo-plan-ring-streaming";
const SESSION_ID = "session-plan-ring-streaming";
const TURN_ID = "turn-plan-ring-streaming";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-plan-ring-streaming-${String(sequenceNumber)}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-plan-ring-streaming",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function turnStarted(offsetMs: number): SessionEvent {
  return event(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "写计划", executionKind: "agent" },
    offsetMs,
  );
}

function schedulePlan(offsetMs: number): SessionEvent {
  return event(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId: "call-plan",
      assistantMessageId: "assistant-plan",
      toolName: "CreatePlan",
      input: { title: "标题", overview: "概述", plan: "# 计划" },
      schedule: { parallelGroups: [["call-plan"]], executionOrder: ["call-plan"] },
    },
    offsetMs,
  );
}

function summaryOf(frame: SessionsIndexTopicFrame): SessionSummary | undefined {
  if (frame.payload.kind === "snapshot") {
    return frame.payload.snapshot.sessions.find((session) => session.sessionId === SESSION_ID);
  }
  return frame.payload.deltas
    .filter(
      (delta): delta is Extract<typeof delta, { op: "session.upserted" }> =>
        delta.op === "session.upserted" && delta.session.sessionId === SESSION_ID,
    )
    .at(-1)?.session;
}

function completeWire(wire: RoutedTopicWireFrame): SessionsIndexTopicFrame {
  assert.equal(wire.kind, "complete", "测试帧应远小于分片阈值");
  return wire.frame;
}

interface GatewayTestAccess {
  indexPublishers: {
    get(workspaceId: string): SessionsIndexPublisher | undefined;
  };
  publishers: Map<string, ConversationTopicPublisher>;
}

interface ChainContext {
  gateway: ConversationV4Gateway;
  sent: RoutedTopicWireFrame[];
  errors: Array<{ scope: string; error: unknown }>;
  desktopSubscriptionId: string;
  webSubscriptionId: string;
  framesFor(subscriptionId: string): SessionsIndexTopicFrame[];
  finalSummaryFor(subscriptionId: string): SessionSummary | undefined;
  dispose(): void;
}

async function setupChain(): Promise<ChainContext> {
  sequenceNumber = 0;
  const sent: RoutedTopicWireFrame[] = [];
  const errors: Array<{ scope: string; error: unknown }> = [];
  const host = {
    sessionExists: () => true,
    emitWireFrame: (wire: RoutedTopicWireFrame) => sent.push(wire),
    onError: (scope: string, error: unknown) => errors.push({ scope, error }),
    getSessionWorkspaceId: () => WORKSPACE_ID,
    isDraftSession: () => false,
    getSessionIndexMeta: () => ({ createdAt: T0, lastActivityAt: T0 }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "plan-ring-streaming-epoch",
  });
  const topic = sessionsIndexTopic(WORKSPACE_ID);
  const desktop = await gateway.subscribeSessionsIndexReserved({
    topic,
    connectionId: "desktop-connection",
    clientMode: "desktop-continuous",
  });
  assert.equal(desktop.commit(), true);
  const web = await gateway.subscribeSessionsIndexReserved({
    topic,
    connectionId: "web-connection",
    clientMode: "web-remote-replayable",
  });
  assert.equal(web.commit(), true);
  assert.ok(
    (gateway as unknown as GatewayTestAccess).indexPublishers.get(WORKSPACE_ID),
    "gateway 必须为 workspace 建 index publisher",
  );
  // 订阅初始帧与本测试的数据无关，清掉后才能按「本次 ingest 产生的帧」断言。
  sent.length = 0;

  const framesFor = (subscriptionId: string) =>
    sent
      .filter((wire) => wire.subscriptionId === subscriptionId)
      .map((wire) => completeWire(wire));
  return {
    gateway,
    sent,
    errors,
    desktopSubscriptionId: desktop.ack.subscriptionId,
    webSubscriptionId: web.ack.subscriptionId,
    framesFor,
    finalSummaryFor(subscriptionId: string) {
      return framesFor(subscriptionId)
        .map((frame) => summaryOf(frame))
        .filter((summary): summary is SessionSummary => summary !== undefined)
        .at(-1);
    },
    dispose() {
      gateway.dispose();
      assert.deepEqual(errors, [], "在线帧投递不应产生 host 错误");
    },
  };
}

function assertBothProfiles(chain: ChainContext, expected: boolean, label: string): void {
  const desktopFrames = chain.framesFor(chain.desktopSubscriptionId);
  const webFrames = chain.framesFor(chain.webSubscriptionId);
  const desktop = chain.finalSummaryFor(chain.desktopSubscriptionId);
  const web = chain.finalSummaryFor(chain.webSubscriptionId);
  // 字段是可选的：true 时显式带 true，清除时字段缺席即「无描边」。
  const wireValue = expected ? true : undefined;
  if (!expected) {
    // 假通过防护：false 不能由「没有帧 / summary 不存在」冒充，必须是确实发布了
    // 清除帧、且 index 里的当前摘要明确不是 true。
    assert.ok(desktopFrames.length > 0, `${label}: desktop 必须收到清除帧`);
    assert.ok(webFrames.length > 0, `${label}: web 必须收到清除帧`);
    assert.ok(desktop, `${label}: desktop 当前摘要必须存在`);
    assert.ok(web, `${label}: web 当前摘要必须存在`);
    assert.notEqual(desktop.lastTurnHasPlanCard, true, `${label}: desktop 仍带描边`);
    assert.notEqual(web.lastTurnHasPlanCard, true, `${label}: web 仍带描边`);
  }
  assert.equal(desktop?.lastTurnHasPlanCard, wireValue, `${label}: desktop`);
  assert.equal(web?.lastTurnHasPlanCard, wireValue, `${label}: web`);
  assert.deepEqual(web, desktop, `${label}: 两档 delivery profile 必须拿到同一份摘要`);
}

test("text_start 开新响应：不发 TurnComplete / ToolCallResult 也立即清除描边，双档同源", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    chain.gateway.ingest(SESSION_ID, schedulePlan(1_000));
    assertBothProfiles(chain, true, "计划工具入账后");

    chain.sent.length = 0;
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        { kind: "text_start", assistantMessageId: "assistant-followup", partId: "part-followup" },
        2_000,
      ),
    );

    assertBothProfiles(chain, false, "后续 text_start（空正文）后");
    assert.ok(
      chain.framesFor(chain.desktopSubscriptionId).length > 0,
      "desktop-continuous 必须收到清除帧",
    );
    assert.ok(
      chain.framesFor(chain.webSubscriptionId).length > 0,
      "web-remote-replayable 必须收到清除帧",
    );

    // 新订阅拿 snapshot：不依赖清除 delta 的重放，确认两档冷读也同源。
    chain.sent.length = 0;
    const topic = sessionsIndexTopic(WORKSPACE_ID);
    for (const [connectionId, clientMode] of [
      ["desktop-snapshot", "desktop-continuous"],
      ["web-snapshot", "web-remote-replayable"],
    ] as const) {
      const subscribed = await chain.gateway.subscribeSessionsIndexReserved({
        topic,
        connectionId,
        clientMode,
      });
      assert.equal(subscribed.commit(), true);
      const initialFrame = subscribed.initialFrame;
      assert.equal(initialFrame?.payload.kind, "snapshot", `${connectionId} 初始帧应是 snapshot`);
      const snapshot =
        initialFrame?.payload.kind === "snapshot" ? initialFrame.payload.snapshot : undefined;
      const summary = snapshot?.sessions.find((session) => session.sessionId === SESSION_ID);
      assert.equal(summary?.lastTurnHasPlanCard, undefined, `${connectionId} snapshot 不得带旧描边`);
    }
  } finally {
    chain.dispose();
  }
});

test("reasoning_start 开新响应：不发 TurnComplete / ToolCallResult 也立即清除描边", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    chain.gateway.ingest(SESSION_ID, schedulePlan(1_000));
    assertBothProfiles(chain, true, "计划工具入账后");

    chain.sent.length = 0;
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        { kind: "reasoning_start", assistantMessageId: "assistant-followup", partId: "part-followup" },
        2_000,
      ),
    );

    assertBothProfiles(chain, false, "后续 reasoning_start 后");
  } finally {
    chain.dispose();
  }
});

test("reasoning_phase_start 与计划同 response 时不清除；新 response 时清除", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    chain.gateway.ingest(SESSION_ID, schedulePlan(1_000));
    assertBothProfiles(chain, true, "计划工具入账后");

    // phase 行必须用 assistantMessageId 作为 response 身份；provider responseId 是另一套
    // 物理响应 id，拿它当锚点会把「同一 response 的后续 phase」误判成新响应。
    // 不清空 sent：同值不产帧，沿用计划入账后的 true 摘要即可证明未被误清除。
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "reasoning_phase_start",
          assistantMessageId: "assistant-plan",
          responseId: "provider-response-plan",
          observedAt: T0 + 1_500,
          phaseStartedAt: T0 + 1_500,
        },
        1_500,
      ),
    );
    assertBothProfiles(chain, true, "同 response 的 reasoning_phase_start 后");

    // 一个 reasoning phase 必须先结束，下一次 phase_start 才能落新行；
    // 不补 phase_end 时投影会丢弃第二个 phase_start，测试会因「无帧」假通过。
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "reasoning_phase_end",
          assistantMessageId: "assistant-plan",
          observedAt: T0 + 1_800,
          phaseEndedAt: T0 + 1_800,
          phaseEndReason: "text",
        },
        1_800,
      ),
    );

    chain.sent.length = 0;
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "reasoning_phase_start",
          assistantMessageId: "assistant-followup",
          responseId: "provider-response-followup",
          observedAt: T0 + 2_000,
          phaseStartedAt: T0 + 2_000,
        },
        2_000,
      ),
    );
    assertBothProfiles(chain, false, "新 response 的 reasoning_phase_start 后");
  } finally {
    chain.dispose();
  }
});

test("plan 工具流式半成卡：tool_input_delta 到达即有描边，无需 tool_input_end / 结果事件", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_start",
          toolCallId: "call-streaming-plan",
          assistantMessageId: "assistant-streaming-plan",
          toolName: "CreatePlan",
        },
        1_000,
      ),
    );
    assertBothProfiles(chain, false, "tool_input_start 尚无内容时");

    chain.sent.length = 0;
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_delta",
          toolCallId: "call-streaming-plan",
          assistantMessageId: "assistant-streaming-plan",
          delta: '{"title":"标题","overview":"概述","plan":"# 计',
        },
        1_100,
      ),
    );
    assertBothProfiles(chain, true, "首个合法半成卡 delta 后");
  } finally {
    chain.dispose();
  }
});

test("缺 start 的 text/reasoning delta 自开新 response：立即清除描边，稳定后不重复发帧", async () => {
  for (const kind of ["text_delta", "reasoning_delta"] as const) {
    const chain = await setupChain();
    try {
      chain.gateway.ingest(SESSION_ID, turnStarted(0));
      chain.gateway.ingest(SESSION_ID, schedulePlan(1_000));
      assertBothProfiles(chain, true, `${kind}: 计划工具入账后`);

      chain.sent.length = 0;
      // 不发 text_start / reasoning_start，直接让 delta 由投影自开新 response 行。
      chain.gateway.ingest(
        SESSION_ID,
        event(
          SessionEventType.ModelStreaming,
          {
            kind,
            assistantMessageId: "assistant-followup",
            partId: "part-followup",
            delta: "字",
          },
          2_000,
        ),
      );
      assertBothProfiles(chain, false, `${kind}: 缺 start 的自开行后`);

      chain.sent.length = 0;
      for (let index = 0; index < 20; index += 1) {
        chain.gateway.ingest(
          SESSION_ID,
          event(
            SessionEventType.ModelStreaming,
            {
              kind,
              assistantMessageId: "assistant-followup",
              partId: "part-followup",
              delta: "字",
            },
            2_001 + index,
          ),
        );
      }
      assert.equal(chain.sent.length, 0, `${kind}: 同 response 的后续 token 不得反复发帧`);
    } finally {
      chain.dispose();
    }
  }
});

test("publisher 恢复时已存在 inputStreaming 计划行：后续 delta 回查权威行并补描边", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    // 先让同一 response 的空 text_start 正常经过 gateway，建立 response 身份缓存；
    // 后续恢复行 delta 不能靠「身份变化」碰巧触发，只能靠权威行回查补登记。
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          assistantMessageId: "assistant-restored-plan",
          partId: "part-restored-plan",
        },
        500,
      ),
    );
    const publisher = (chain.gateway as unknown as GatewayTestAccess).publishers.get(SESSION_ID);
    assert.ok(publisher, "turnStarted 后应有 conversation publisher");

    // 绕过 gateway 的 ingest 建立 projection 行：模拟恢复/中途接管的 publisher，
    // 此时 gateway 的 streamingPlanToolIds 没有这条 toolCallId 的登记。
    const restoredStart = event(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        toolCallId: "call-restored-plan",
        assistantMessageId: "assistant-restored-plan",
        toolName: "CreatePlan",
      },
      1_000,
    );
    publisher.ingest(restoredStart);
    const restoredDelta = event(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        toolCallId: "call-restored-plan",
        assistantMessageId: "assistant-restored-plan",
        delta: '{"title":"恢复计划","overview":"恢复后的半成卡"',
      },
      1_100,
    );
    publisher.ingest(restoredDelta);
    // 这两条绕过了 gateway，不能让 gateway 的 raw sequence 误判为空洞：
    // 下一条 gateway 事件继续用 text_start 之后的下一个序号。
    sequenceNumber = 2;
    assert.equal(
      publisher.getToolCallRow("call-restored-plan")?.status,
      "inputStreaming",
      "前置条件：权威行仍在流式输入",
    );
    assert.equal(
      hasPlanCardInLastAssistantResponse(publisher.getSnapshot().rows.window),
      true,
      "前置条件：恢复后的半成卡已能撑起计划卡",
    );
    chain.sent.length = 0;

    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_delta",
          toolCallId: "call-restored-plan",
          assistantMessageId: "assistant-restored-plan",
          delta: ',"plan":"# 恢复计划"}',
        },
        1_200,
      ),
    );
    assert.equal(
      hasPlanCardInLastAssistantResponse(publisher.getSnapshot().rows.window),
      true,
      "delta 后权威投影仍是一张半成卡",
    );
    assert.ok(chain.sent.length > 0, "恢复后的首个 delta 必须产生列表帧");
    assertBothProfiles(chain, true, "恢复行后的首个 delta");
  } finally {
    chain.dispose();
  }
});

test("摘要已稳定后 text_delta 不触发全量 summary 发布", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    chain.gateway.ingest(SESSION_ID, schedulePlan(1_000));
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        { kind: "text_start", assistantMessageId: "assistant-followup", partId: "part-followup" },
        2_000,
      ),
    );
    assertBothProfiles(chain, false, "清除后");

    chain.sent.length = 0;
    for (let index = 0; index < 20; index += 1) {
      chain.gateway.ingest(
        SESSION_ID,
        event(
          SessionEventType.ModelStreaming,
          {
            kind: "text_delta",
            assistantMessageId: "assistant-followup",
            partId: "part-followup",
            delta: "字",
          },
          2_001 + index,
        ),
      );
    }
    assert.equal(chain.sent.length, 0, "重复 text_delta 不得反复重算并下发列表摘要");
  } finally {
    chain.dispose();
  }
});
