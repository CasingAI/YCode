// 「投影是对的、列表行是错的」这一类故障的诊断回归测试。
//
// 症状与消费端故障（raw seq 空洞、undelivered 记账）正好相反：投影侧一切正常，
// 事件全部 ingest、deriveSessionSummary 派生出的 phase 与 pendingInteractionSummary
// 都是收口后的值，缺口检测与 undelivered 记账都不会触发——因为确实没丢事件。
// 但 UI 拿到的索引帧停在更早的那一帧上，同一份旧 summary 的两个字段一起僵住：
// 列表转圈 + 「等待确认」，而实际上没有任何东西在跑。
//
// 可疑路径是 control reservation：subscribe/resync 的 initial reservation 进
// request-scoped outbox，由 outbox admission 调 commit() 摘掉自己；窗口期内 online
// flush 复用同一 inFlight 被 emitReservation 静默 return false 抑制，这是设计意图。
// 但 postResponseOutbox.delete(request.id)（server.ts 的 clearPostResponseMessages
// 与每请求开头的清理）会直接删掉条目，既不 commit 也不 rollback——reservation 就此
// 永远留在 controlReservations 与 subscription.inFlight 里，此后每次 flush 都取到
// 同一个死 reservation、每次都被静默吞掉。
//
// 该路径此前零日志、零 onError、断档检测也不触发（帧根本没发，不是发了被丢），
// 完全不可观测。本文件锁定新加的 fault.sessionsIndex.stuckReservation 诊断：
// 正常往返不报，卡死必报，且带上「publisherSeq 已增长而该订阅 sentSeq 不动」这个判据。
import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionsIndexTopic,
  type ConversationSnapshot,
  type SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const WORKSPACE_ID = "workspace-stuck";
const SESSION_ID = "session-stuck";
const CONNECTION_ID = "connection-1";
const T0 = 1_700_000_000_000;
const STUCK_SCOPE = "fault.sessionsIndex.stuckReservation";

interface CapturedError {
  scope: string;
  error: unknown;
  context: Record<string, unknown>;
}

interface IndexPublisherTestAccess {
  ingestConversation: (s: ConversationSnapshot, e: unknown) => boolean;
  seq: number;
  subscriptionWatermark(id: string): { sentSeq: number; inFlightStuck: boolean } | null;
}

interface GatewayTestAccess {
  indexPublishers: Map<string, IndexPublisherTestAccess>;
  flushIndex: (workspaceId: string) => void;
}

function createGateway(errors: CapturedError[], stuckMs: number): ConversationV4Gateway {
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    onError: (scope: string, error: unknown, context: Record<string, unknown> = {}) => {
      errors.push({ scope, error, context });
    },
  } as unknown as V4GatewayHost;
  return new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "stuck-epoch",
    stuckControlReservationMs: stuckMs,
  });
}

function snapshotOf(phase: SessionPhase, revision = 1): ConversationSnapshot {
  const terminal = phase.startsWith("completed") || phase === "error";
  return {
    sessionId: SESSION_ID,
    logEpoch: "session-epoch",
    revision,
    control: { phase, sessionEnded: terminal },
    meta: { title: "计划会话", titleSource: "generated" },
    rows: { window: [] },
    backgroundWorks: [],
    pendingInteractions: [],
    workflowRuns: [],
  } as unknown as ConversationSnapshot;
}

function publisherOf(gateway: ConversationV4Gateway): IndexPublisherTestAccess {
  const publisher = (gateway as unknown as GatewayTestAccess).indexPublishers.get(WORKSPACE_ID);
  assert.ok(publisher, "index publisher 应已建立");
  return publisher;
}

function subscribe(gateway: ConversationV4Gateway) {
  return gateway.subscribeSessionsIndexReserved({
    topic: sessionsIndexTopic(WORKSPACE_ID),
    connectionId: CONNECTION_ID,
    clientMode: "desktop-continuous",
  });
}

function stuckDiagnostics(errors: CapturedError[]): CapturedError[] {
  return errors.filter((entry) => entry.scope === STUCK_SCOPE);
}

test("正常 subscribe 往返不报卡死：commit 之后就摘掉了", async () => {
  const errors: CapturedError[] = [];
  const gateway = createGateway(errors, 0);

  try {
    const dispatch = await subscribe(gateway);
    // 正常路径：ACK 发出后由 outbox admission 调 commit。
    assert.equal(dispatch.commit(), true);

    const publisher = publisherOf(gateway);
    assert.equal(
      publisher.ingestConversation(snapshotOf("running"), {
        createdAt: T0,
        lastActivityAt: T0 + 1,
      }),
      true,
    );
    (gateway as unknown as GatewayTestAccess).flushIndex(WORKSPACE_ID);

    assert.deepEqual(stuckDiagnostics(errors), []);
  } finally {
    gateway.dispose();
  }
});

test("outbox 条目在 admission 前被删除（既不 commit 也不 rollback）后必报卡死", async () => {
  const errors: CapturedError[] = [];
  // 阈值设为 0，让第一次 flush 就越过判定窗口。
  const gateway = createGateway(errors, 0);

  try {
    const dispatch = await subscribe(gateway);
    // 故障路径：reservation 进了 outbox，条目在 admission 前被 delete，
    // commit() 永远不被调用——既不 commit 也不 rollback。
    assert.ok(dispatch.initialFrame, "订阅应已产生 initial frame");

    const publisher = publisherOf(gateway);
    assert.equal(
      publisher.ingestConversation(snapshotOf("running"), {
        createdAt: T0,
        lastActivityAt: T0 + 1,
      }),
      true,
    );
    (gateway as unknown as GatewayTestAccess).flushIndex(WORKSPACE_ID);

    const diagnostics = stuckDiagnostics(errors);
    assert.equal(diagnostics.length, 1, "卡死必须被诊断出来");
    const { context } = diagnostics[0] as CapturedError;
    assert.equal(context.workspaceId, WORKSPACE_ID);
    assert.equal(context.topic, sessionsIndexTopic(WORKSPACE_ID));
    assert.equal(context.subscriptionId, dispatch.ack.subscriptionId);
    assert.equal(context.indexSubscriptionPresent, true);
    assert.equal(context.indexSubscriptionStuck, true, "inFlight 应仍被占用");
    // 判据：publisher 的水位在涨，这个订阅的 sentSeq 却没动。
    assert.equal(typeof context.publisherSeq, "number");
    assert.equal(typeof context.indexSentSeq, "number");
    assert.ok(
      (context.publisherSeq as number) > (context.indexSentSeq as number),
      `publisherSeq(${String(context.publisherSeq)}) 应大于 sentSeq(${String(context.indexSentSeq)})`,
    );
  } finally {
    gateway.dispose();
  }
});

test("同一条卡死 reservation 只报一次，不在每次 flush 刷屏", async () => {
  const errors: CapturedError[] = [];
  const gateway = createGateway(errors, 0);

  try {
    await subscribe(gateway);
    const publisher = publisherOf(gateway);

    for (const [index, phase] of (["running", "completedSuccess", "running"] as const).entries()) {
      publisher.ingestConversation(snapshotOf(phase, index + 1), {
        createdAt: T0,
        lastActivityAt: T0 + index + 1,
      });
      (gateway as unknown as GatewayTestAccess).flushIndex(WORKSPACE_ID);
    }

    assert.equal(stuckDiagnostics(errors).length, 1, "同一 reservation 只应报一次");
  } finally {
    gateway.dispose();
  }
});

test("仍在在飞窗口内被抑制不算卡死：时间门槛不能被去掉", async () => {
  const errors: CapturedError[] = [];
  // 门槛取生产值量级：ACK 往返远小于此。
  const gateway = createGateway(errors, 30_000);

  try {
    // 订阅后立刻 flush，此时 reservation 已进 controlReservations 但尚未 commit
    // ——这正是注释里描述的正常抑制场景（outbox 还没 admission）。
    await subscribe(gateway);
    const publisher = publisherOf(gateway);
    publisher.ingestConversation(snapshotOf("running"), {
      createdAt: T0,
      lastActivityAt: T0 + 1,
    });
    (gateway as unknown as GatewayTestAccess).flushIndex(WORKSPACE_ID);

    assert.deepEqual(
      stuckDiagnostics(errors),
      [],
      "在飞窗口内的抑制是设计意图，不得报卡死",
    );
  } finally {
    gateway.dispose();
  }
});

test("reservation watermark 读口能区分「订阅不存在」与「inFlight 卡住」", async () => {
  const errors: CapturedError[] = [];
  const gateway = createGateway(errors, 0);

  try {
    const dispatch = await subscribe(gateway);
    const publisher = publisherOf(gateway);

    const watermark = publisher.subscriptionWatermark(dispatch.ack.subscriptionId);
    assert.equal(watermark?.inFlightStuck, true, "未 commit 时 inFlight 仍被占用");
    assert.equal(watermark?.sentSeq, 0, "未 commit 时水位没推进");
    assert.equal(publisher.subscriptionWatermark("不存在的订阅"), null);
  } finally {
    gateway.dispose();
  }
});
