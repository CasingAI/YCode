import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  sessionsIndexTopic,
  sessionsIndexTopicWireFrameSchema,
  type RoutedTopicWireFrame,
  type SessionSummary,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

// docs/specs/stop-success-terminal-arbitration.md 验收边界：
// 真实 ProductProjection → SessionsIndexPublisher → gateway 在线帧。
// 这里只验证 CLI 生产端（投影 + 索引发布）；UI 的 applySessionsIndexFrame 与通知
// collector 由 UI 包自己的测试覆盖，bootstrap 不得跨包导入 UI 私有实现。
//
// Desktop continuous 与 Web replayable 的 sessions-index 订阅消费同一摘要源；
// 两个 clientMode 用不同 connectionId 同时订阅，验证单帧、背压合帧的最终摘要一致。

const WORKSPACE_ID = "/repo-stop-notification";
const SESSION_ID = "session-stop-notification";
const TURN_ID = "turn-stop-notification";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-stop-notification",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function goal(status: "active" | "paused") {
  return {
    sessionID: SESSION_ID,
    targetID: "goal-1",
    objective: "完成目标",
    summaryTitle: null,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    activeRunStartedAtMs: null,
    time: { created: T0, updated: T0 },
  };
}

function targetChanged(status: "active" | "paused", offsetMs: number, action = "set") {
  const target = goal(status);
  return event(
    SessionEventType.TargetChanged,
    {
      action,
      source: "runtime",
      target,
      ...(action === "status_updated"
        ? { previousTarget: goal(status === "active" ? "paused" : "active") }
        : {}),
    },
    offsetMs,
  );
}

function turnStarted(turnNumber: number, offsetMs: number): SessionEvent {
  return event(
    SessionEventType.TurnStarted,
    { turnNumber, input: "继续", executionKind: "agent" },
    offsetMs,
  );
}

function turnComplete(
  resultType: "success" | "cancelled",
  offsetMs: number,
  preserveQueueAutoDrainOnCancel?: boolean,
): SessionEvent {
  return event(
    SessionEventType.TurnComplete,
    {
      response: resultType === "success" ? "完成" : "",
      tokenCount: 0,
      toolCallCount: 0,
      duration: 1_000,
      resultType,
      ...(preserveQueueAutoDrainOnCancel === undefined ? {} : { preserveQueueAutoDrainOnCancel }),
    },
    offsetMs,
  );
}

function queuedInput(offsetMs: number): SessionEvent {
  return event(
    SessionEventType.TurnSteerQueued,
    {
      pendingInputId: "pending-1",
      input: "排队输入",
      inputPreview: "排队输入",
      inputSize: 4,
      targetTurnId: TURN_ID,
      queueLength: 1,
    },
    offsetMs,
  );
}

function summaryOf(frame: SessionsIndexTopicFrame): SessionSummary | undefined {
  if (frame.payload.kind === "snapshot") {
    return frame.payload.snapshot.sessions.find((session) => session.sessionId === SESSION_ID);
  }
  const upserts = frame.payload.deltas.filter(
    (delta): delta is Extract<typeof delta, { op: "session.upserted" }> =>
      delta.op === "session.upserted" && delta.session.sessionId === SESSION_ID,
  );
  return upserts.at(-1)?.session;
}

function completeWire(wire: RoutedTopicWireFrame): SessionsIndexTopicFrame {
  assert.equal(wire.kind, "complete", "测试帧应远小于分片阈值");
  return wire.frame;
}

interface GatewayTestAccess {
  indexPublishers: {
    get(workspaceId: string): SessionsIndexPublisher | undefined;
  };
  flushIndex(workspaceId: string): void;
}

interface ChainContext {
  gateway: ConversationV4Gateway;
  publisher: SessionsIndexPublisher;
  projection: ProductProjection;
  desktopSubscriptionId: string;
  webSubscriptionId: string;
  sent: RoutedTopicWireFrame[];
  ingest(lastActivityAt: number): void;
  flush(): void;
  framesFor(subscriptionId: string): SessionsIndexTopicFrame[];
  finalSummaryFor(subscriptionId: string): SessionSummary | undefined;
  dispose(): void;
}

async function setupChain(): Promise<ChainContext> {
  const sent: RoutedTopicWireFrame[] = [];
  const errors: Array<{ scope: string; error: unknown }> = [];
  const host = {
    sessionExists: () => false,
    emitWireFrame: (wire: RoutedTopicWireFrame) => sent.push(wire),
    onError: (scope: string, error: unknown) => errors.push({ scope, error }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "index-epoch",
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

  const publisher = (gateway as unknown as GatewayTestAccess).indexPublishers.get(WORKSPACE_ID);
  assert.ok(publisher, "gateway 必须为 workspace 建 index publisher");
  const projection = new ProductProjection(SESSION_ID, "session-epoch");
  // 订阅初始帧与本测试的数据无关，清掉后才能按“本次投递”断言。
  sent.length = 0;

  let lastActivityAt = T0;
  return {
    gateway,
    publisher,
    projection,
    desktopSubscriptionId: desktop.ack.subscriptionId,
    webSubscriptionId: web.ack.subscriptionId,
    sent,
    ingest(nextLastActivityAt: number) {
      lastActivityAt = nextLastActivityAt;
      publisher.ingestConversation(projection.getSnapshot(), {
        createdAt: T0,
        lastActivityAt,
      });
    },
    flush() {
      (gateway as unknown as GatewayTestAccess).flushIndex(WORKSPACE_ID);
    },
    framesFor(subscriptionId: string) {
      return sent
        .filter((wire) => wire.subscriptionId === subscriptionId)
        .map((wire) => completeWire(wire));
    },
    finalSummaryFor(subscriptionId: string) {
      return this.framesFor(subscriptionId)
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

test("用户 stop：两个 delivery profile 的最终摘要都是 completedInterrupted，队列 held", async () => {
  const chain = await setupChain();
  try {
    chain.projection.applyEvent(targetChanged("active", 0));
    chain.projection.applyEvent(turnStarted(1, 1));
    chain.projection.applyEvent(queuedInput(2));
    chain.ingest(T0 + 2);
    chain.flush();

    const running = chain.finalSummaryFor(chain.desktopSubscriptionId);
    assert.equal(running?.phase, "running");
    assert.equal(running?.goalStatus, "active");

    // 已接受的用户 stop：取消终态 + goal paused + 队列保留且 autoDrain=false。
    chain.projection.applyEvent(turnComplete("cancelled", 3));
    chain.ingest(T0 + 3);
    chain.flush();

    const snapshot = chain.projection.getSnapshot();
    assert.equal(snapshot.control.phase, "completedInterrupted");
    assert.equal(snapshot.goal?.status, "paused");
    assert.equal(snapshot.queue.items.length, 1, "stop 不得丢队列项");
    assert.equal(snapshot.queue.autoDrain, false);
    assert.equal(snapshot.queue.pauseReason, "stopped");

    for (const subscriptionId of [chain.desktopSubscriptionId, chain.webSubscriptionId]) {
      const terminal = chain.finalSummaryFor(subscriptionId);
      assert.equal(terminal?.phase, "completedInterrupted");
      assert.equal(terminal?.goalStatus, "paused");
    }
    // 关键不变量：取消链路上任何一帧都不能被解释成成功。
    assert.equal(
      chain.sent.some((wire) => summaryOf(completeWire(wire))?.phase === "completedSuccess"),
      false,
    );
  } finally {
    chain.dispose();
  }
});

test("背压/合帧：desktop 恢复后的合并帧与 web 在线帧最终都保留 completedInterrupted", async () => {
  const chain = await setupChain();
  try {
    // transport high-water：desktop 暂停在线 flush，期间的 delta 只累积不投递。
    chain.gateway.setConnectionFlowState({
      connectionId: "desktop-connection",
      state: "saturated",
    });

    chain.projection.applyEvent(targetChanged("active", 0));
    chain.projection.applyEvent(turnStarted(1, 1));
    chain.projection.applyEvent(queuedInput(2));
    chain.ingest(T0 + 2);
    chain.flush();
    assert.equal(chain.framesFor(chain.desktopSubscriptionId).length, 0);

    chain.projection.applyEvent(turnComplete("cancelled", 3));
    chain.ingest(T0 + 3);
    chain.flush();
    assert.equal(chain.finalSummaryFor(chain.webSubscriptionId)?.phase, "completedInterrupted");
    assert.equal(chain.framesFor(chain.desktopSubscriptionId).length, 0);

    // drained 触发一次 flush：running + cancelled 的两次摘要推进被合并成同一帧。
    chain.gateway.setConnectionFlowState({
      connectionId: "desktop-connection",
      state: "drained",
    });

    const desktopFrames = chain.framesFor(chain.desktopSubscriptionId);
    assert.equal(desktopFrames.length, 1);
    const merged = desktopFrames[0];
    assert.ok(merged);
    assert.equal(merged.fromSeq, 0);
    assert.equal(merged.toSeq, 2);
    assert.equal(summaryOf(merged)?.phase, "completedInterrupted");
    assert.equal(summaryOf(merged)?.goalStatus, "paused");

    for (const subscriptionId of [chain.desktopSubscriptionId, chain.webSubscriptionId]) {
      assert.equal(chain.finalSummaryFor(subscriptionId)?.phase, "completedInterrupted");
    }
  } finally {
    chain.dispose();
  }
});

test("内部抢占 preserve 取消不 hold 队列；后续成功最终摘要为 completedSuccess + paused", async () => {
  const chain = await setupChain();
  try {
    chain.projection.applyEvent(targetChanged("active", 0));
    chain.projection.applyEvent(turnStarted(1, 1));
    chain.projection.applyEvent(queuedInput(2));
    chain.ingest(T0 + 2);
    chain.flush();

    // sendQueuedNow / edit-resend 的内部抢占：取消当前 turn，但保留队列 autoDrain。
    chain.projection.applyEvent(turnComplete("cancelled", 3, true));
    chain.ingest(T0 + 3);
    chain.flush();

    let snapshot = chain.projection.getSnapshot();
    assert.equal(snapshot.control.phase, "completedInterrupted");
    assert.equal(snapshot.goal?.status, "paused");
    assert.equal(snapshot.queue.items.length, 1);
    assert.equal(snapshot.queue.autoDrain, true, "内部抢占不得关闭队列自动消费");
    assert.equal(snapshot.queue.pauseReason, undefined);

    // 抢占后的续跑正常成功：最终摘要必须是成功，不能被前面的取消终态粘住。
    chain.projection.applyEvent(turnStarted(2, 4));
    chain.projection.applyEvent(turnComplete("success", 5));
    chain.ingest(T0 + 5);
    chain.flush();

    snapshot = chain.projection.getSnapshot();
    assert.equal(snapshot.control.phase, "completedSuccess");
    assert.equal(snapshot.goal?.status, "paused");
    assert.equal(snapshot.queue.autoDrain, true);
    for (const subscriptionId of [chain.desktopSubscriptionId, chain.webSubscriptionId]) {
      const final = chain.finalSummaryFor(subscriptionId);
      assert.equal(final?.phase, "completedSuccess");
      assert.equal(final?.goalStatus, "paused");
    }
  } finally {
    chain.dispose();
  }
});

test("plan/readonly 暂停与成功合帧：最终摘要保持 completedSuccess + paused", async () => {
  const chain = await setupChain();
  try {
    chain.projection.applyEvent(targetChanged("active", 0));
    chain.projection.applyEvent(turnStarted(1, 1));
    chain.ingest(T0 + 1);
    chain.flush();

    // 运行中切 plan/readonly：目标暂停，但当前回合仍正常结束；两件事在同一帧内合并。
    chain.projection.applyEvent(targetChanged("paused", 2, "status_updated"));
    chain.projection.applyEvent(turnComplete("success", 3));
    chain.ingest(T0 + 3);
    chain.flush();

    assert.equal(chain.projection.getSnapshot().control.phase, "completedSuccess");
    assert.equal(chain.projection.getSnapshot().goal?.status, "paused");
    for (const subscriptionId of [chain.desktopSubscriptionId, chain.webSubscriptionId]) {
      const final = chain.finalSummaryFor(subscriptionId);
      assert.equal(final?.phase, "completedSuccess", "TargetChanged 只能改 goal，不能改写 phase");
      assert.equal(final?.goalStatus, "paused");
    }
  } finally {
    chain.dispose();
  }
});

test("plan/readonly 暂停与成功分帧：web replayable 两帧最终仍是 completedSuccess + paused", async () => {
  const chain = await setupChain();
  try {
    chain.projection.applyEvent(targetChanged("active", 0));
    chain.projection.applyEvent(turnStarted(1, 1));
    chain.ingest(T0 + 1);
    chain.flush();

    chain.projection.applyEvent(targetChanged("paused", 2, "status_updated"));
    chain.ingest(T0 + 2);
    chain.flush();

    const pausedFrame = chain.finalSummaryFor(chain.webSubscriptionId);
    assert.equal(pausedFrame?.phase, "running");
    assert.equal(pausedFrame?.goalStatus, "paused");

    chain.projection.applyEvent(turnComplete("success", 3));
    chain.ingest(T0 + 3);
    chain.flush();

    const frames = chain.framesFor(chain.webSubscriptionId);
    assert.ok(frames.length >= 2, "分帧场景必须实际产生两帧");
    const final = chain.finalSummaryFor(chain.webSubscriptionId);
    assert.equal(final?.phase, "completedSuccess");
    assert.equal(final?.goalStatus, "paused");
    assert.equal(
      frames.some((frame) => summaryOf(frame)?.phase === "completedInterrupted"),
      false,
      "goal 暂停不得伪造中断",
    );
  } finally {
    chain.dispose();
  }
});
