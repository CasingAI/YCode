// 描边提示落盘的回归：gateway 只在「最后一轮是否有计划卡」相对已发布基线翻转时
// 调用宿主 persistLastTurnPlanCard，进程内首次发布写一次基线；钩子抛错只记
// onError，不阻断 sessions-index 发布。冷启动种子靠这次持久化恢复未加载会话的描边。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  sessionsIndexTopic,
  type RoutedTopicWireFrame,
  type SessionSummary,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const WORKSPACE_ID = "/repo-plan-card-persist";
const SESSION_ID = "session-plan-card-persist";
const TURN_ID = "turn-plan-card-persist";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-plan-card-persist-${String(sequenceNumber)}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-plan-card-persist",
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

interface ChainContext {
  gateway: ConversationV4Gateway;
  sent: RoutedTopicWireFrame[];
  errors: Array<{ scope: string; error: unknown }>;
  persisted: Array<{ sessionId: string; lastTurnHasPlanCard: boolean }>;
  framesFor(subscriptionId: string): SessionsIndexTopicFrame[];
  finalSummary(): SessionSummary | undefined;
  dispose(): void;
}

async function setupChain(hookImpl?: V4GatewayHost["persistLastTurnPlanCard"]): Promise<ChainContext> {
  sequenceNumber = 0;
  const sent: RoutedTopicWireFrame[] = [];
  const errors: Array<{ scope: string; error: unknown }> = [];
  const persisted: Array<{ sessionId: string; lastTurnHasPlanCard: boolean }> = [];
  const host = {
    sessionExists: () => true,
    emitWireFrame: (wire: RoutedTopicWireFrame) => sent.push(wire),
    onError: (scope: string, error: unknown) => errors.push({ scope, error }),
    getSessionWorkspaceId: () => WORKSPACE_ID,
    isDraftSession: () => false,
    getSessionIndexMeta: () => ({ createdAt: T0, lastActivityAt: T0 }),
    persistLastTurnPlanCard:
      hookImpl ??
      ((sessionId: string, lastTurnHasPlanCard: boolean) => {
        persisted.push({ sessionId, lastTurnHasPlanCard });
      }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "plan-card-persist-epoch",
  });
  const subscribed = await gateway.subscribeSessionsIndexReserved({
    topic: sessionsIndexTopic(WORKSPACE_ID),
    connectionId: "desktop-connection",
    clientMode: "desktop-continuous",
  });
  assert.equal(subscribed.commit(), true);
  sent.length = 0;
  return {
    gateway,
    sent,
    errors,
    persisted,
    framesFor(subscriptionId: string) {
      return sent
        .filter((wire) => wire.subscriptionId === subscriptionId)
        .map((wire) => {
          assert.equal(wire.kind, "complete", "测试帧应远小于分片阈值");
          return wire.frame;
        });
    },
    finalSummary() {
      return this.framesFor(subscribed.ack.subscriptionId)
        .map((frame) => summaryOf(frame))
        .filter((summary): summary is SessionSummary => summary !== undefined)
        .at(-1);
    },
    dispose() {
      gateway.dispose();
    },
  };
}

test("描边事实只在翻转时落盘：基线一次、计划入账一次、新响应清除一次", async () => {
  const chain = await setupChain();
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    // 首次发布：基线缺席，按当前值（无计划卡）写一次。
    assert.deepEqual(chain.persisted, [
      { sessionId: SESSION_ID, lastTurnHasPlanCard: false },
    ]);

    chain.persisted.length = 0;
    chain.sent.length = 0;
    chain.gateway.ingest(SESSION_ID, schedulePlan(1_000));
    assert.equal(chain.finalSummary()?.lastTurnHasPlanCard, true, "列表摘要应带描边");
    assert.deepEqual(chain.persisted, [
      { sessionId: SESSION_ID, lastTurnHasPlanCard: true },
    ]);

    // 非流式事件照常全量发布摘要，但描边值未翻转 → 不得重复落盘。
    chain.persisted.length = 0;
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ToolCallResult,
        { toolCallId: "call-plan", result: { success: true, content: "ok" }, duration: 1 },
        1_500,
      ),
    );
    assert.equal(chain.finalSummary()?.lastTurnHasPlanCard, true, "描边应保持");
    assert.deepEqual(chain.persisted, [], "同值发布不得再次落盘");

    // 新响应开始（带响应身份的空 text_start）：描边清除 → 落盘 false。
    chain.persisted.length = 0;
    chain.sent.length = 0;
    chain.gateway.ingest(
      SESSION_ID,
      event(
        SessionEventType.ModelStreaming,
        { kind: "text_start", assistantMessageId: "assistant-followup", partId: "part-followup" },
        2_000,
      ),
    );
    assert.notEqual(chain.finalSummary()?.lastTurnHasPlanCard, true, "描边应已清除");
    assert.deepEqual(chain.persisted, [
      { sessionId: SESSION_ID, lastTurnHasPlanCard: false },
    ]);

    // 同一响应的后续 token：流式门控不触发发布，也不落盘。
    chain.persisted.length = 0;
    chain.sent.length = 0;
    for (let index = 0; index < 10; index += 1) {
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
    assert.deepEqual(chain.persisted, [], "同响应 token 不得落盘");
    assert.deepEqual(chain.errors, [], "全程不应产生 host 错误");
  } finally {
    chain.dispose();
  }
});

test("钩子抛错只记 onError，不阻断摘要发布", async () => {
  const chain = await setupChain(() => {
    throw new Error("persist unavailable");
  });
  try {
    chain.gateway.ingest(SESSION_ID, turnStarted(0));
    chain.sent.length = 0;
    chain.gateway.ingest(SESSION_ID, schedulePlan(1_000));
    assert.equal(chain.finalSummary()?.lastTurnHasPlanCard, true, "钩子失败后摘要仍须发布");
    // 两次翻转（基线 false、计划 true）各尝试一次落盘，两次都只降级为 onError。
    assert.equal(chain.errors.length, 2, "每次翻转各记一次 onError");
    assert.ok(
      chain.errors.every((entry) => entry.scope === "v4.sessionsIndex.persistPlanCard"),
      "错误 scope 应为 persistPlanCard",
    );
  } finally {
    chain.dispose();
  }
});
