// raw seq 空洞的检测、回填自愈与冻结暴露。
//
// 空洞的成因在生产侧（core appendEvent 消耗序号后 notifyEventSinks 被跳过），
// 见 sessionsIndexRawSeqGapFreeze.test.ts。消费侧必须做到三件事：
//   1. 正常的乱序（慢持久化）不得被误判成空洞；
//   2. 真空洞要能从持久事件日志回填自愈，把滞留事件一并排空到回合终态；
//   3. 回填不回来时，投影不得继续以 running + pending 呈现——那是在对用户断言
//      「有东西在跑且在等你确认」。
//
// 另有一条更隐蔽的路径：SessionResumed 是 epoch 边界，会把边界前的滞留事件直接丢掉。
// 丢掉的是本进程已经收到的事实（PermissionResolved / TurnComplete），投影就此永久
// 停在缺口之前，而且完全无声——没有 warn、没有 error，连缺口现场都不会留下。
// 它不需要任何异常就能发生，是同一个症状的第二条独立成因。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import type { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

const SESSION_ID = "session-gap-recovery";
const TURN_ID = "turn-gap-recovery";
const TOOL_CALL_ID = "call-exit-plan-recovery";
const REQUEST_ID = "request-plan-recovery";
const T0 = 1_700_000_000_000;
/** 取远小于真实窗口的值：断言不依赖真实等待，也不改变生产语义。 */
const GAP_TOLERANCE_MS = 20;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number, rawSeq: number) {
  sequenceNumber += 1;
  return {
    id: `event-recovery-${String(sequenceNumber)}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-gap-recovery",
    sequenceNumber: rawSeq,
    payload,
  } as unknown as SessionEvent;
}

interface GatewayTestAccess {
  publishers: Map<string, ConversationTopicPublisher>;
}

interface ErrorRecord {
  scope: string;
  context: Record<string, unknown> | undefined;
}

function createGateway() {
  const errors: ErrorRecord[] = [];
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    onError: (scope: string, _error: unknown, context?: Record<string, unknown>) => {
      errors.push({ scope, context });
    },
    // 持久日志里没有缺失的那条：回填必然落空，用例才能稳定走到「冻结暴露」分支。
    loadPersistedEvents: async () => ({ events: [], synthesized: false, sourceEventSeq: 6 }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "gap-recovery-epoch",
    rawSequenceGapToleranceMs: GAP_TOLERANCE_MS,
  });
  return { gateway, errors };
}

function snapshotOf(gateway: ConversationV4Gateway) {
  const publisher = (gateway as unknown as GatewayTestAccess).publishers.get(SESSION_ID);
  assert.ok(publisher, "会话 publisher 应已建立");
  return publisher.getSnapshot();
}

const turnStarted = () =>
  event(SessionEventType.TurnStarted, { turnNumber: 1, input: "写计划", executionKind: "agent" }, 0, 1);
const toolScheduled = () =>
  event(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId: TOOL_CALL_ID,
      assistantMessageId: "assistant-1",
      toolName: "ExitPlanMode",
      input: { overview: "概述", plan: "# 计划", title: "计划" },
      schedule: { parallelGroups: [[TOOL_CALL_ID]], executionOrder: [TOOL_CALL_ID] },
    },
    1_000,
    2,
  );
const permissionRequested = () =>
  event(
    SessionEventType.PermissionRequested,
    {
      requestId: REQUEST_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: "ExitPlanMode",
      reason: "计划已生成",
      input: { overview: "概述", plan: "# 计划", title: "计划" },
    },
    2_000,
    3,
  );
const permissionResolved = (rawSeq = 4) =>
  event(
    SessionEventType.PermissionResolved,
    { requestId: REQUEST_ID, toolCallId: TOOL_CALL_ID, decision: "deny", reason: "plan_exit_denied" },
    3_000,
    rawSeq,
  );
const turnComplete = (rawSeq = 5) =>
  event(
    SessionEventType.TurnComplete,
    { response: "", tokenCount: 0, toolCallCount: 1, duration: 4_000, resultType: "success" },
    4_000,
    rawSeq,
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, GAP_TOLERANCE_MS * 6));

test("空洞在确认窗口内补齐属于正常乱序，不得报故障也不得标失同步", async () => {
  const { gateway, errors } = createGateway();
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionResolved());
    gateway.ingest(SESSION_ID, turnComplete());
    // raw 3 迟到：滞留事件必须被 drain 干净，且不得触发任何空洞处置。
    gateway.ingest(SESSION_ID, permissionRequested());

    await settle();

    const snapshot = snapshotOf(gateway);
    assert.equal(snapshot.control.phase, "completedSuccess");
    assert.equal(snapshot.pendingInteractions.length, 0);
    assert.deepEqual(errors, [], "正常乱序不得产生任何 error 现场");
  } finally {
    gateway.dispose();
  }
});

test("真空洞必须被一次性记录现场（sessionId、缺口 rawSeq、滞留事件数、滞留时长）", async () => {
  const { gateway, errors } = createGateway();
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionRequested());
    gateway.ingest(SESSION_ID, permissionResolved(5));
    gateway.ingest(SESSION_ID, turnComplete(6));

    await settle();

    const gapErrors = errors.filter((record) => record.scope === "fault.rawSeq.gap");
    assert.equal(gapErrors.length, 1, "同一会话只报一次空洞现场");
    assert.equal(gapErrors[0]?.context?.sessionId, SESSION_ID);
    assert.equal(gapErrors[0]?.context?.missingRawSeq, 4);
    assert.equal(gapErrors[0]?.context?.strandedEventCount, 2);
    assert.equal(typeof gapErrors[0]?.context?.stuckMs, "number");
    assert.ok(
      (gapErrors[0]?.context?.stuckMs ?? 0) >= GAP_TOLERANCE_MS,
      "滞留时长必须覆盖确认窗口",
    );
  } finally {
    gateway.dispose();
  }
});

test("持久事件日志里能补到缺口时，回填自愈并一路排空到回合终态", async () => {
  // 缺失的 raw 4（PermissionResolved）其实一直在 eventStore 里，只是 notify 被跳过。
  const missing = permissionResolved(4);
  const errors: ErrorRecord[] = [];
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    onError: (scope: string, _error: unknown, context?: Record<string, unknown>) => {
      errors.push({ scope, context });
    },
    loadPersistedEvents: async () => ({
      events: [missing],
      synthesized: false,
      sourceEventSeq: 4,
    }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "gap-backfill-epoch",
    rawSequenceGapToleranceMs: GAP_TOLERANCE_MS,
  });
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionRequested());
    gateway.ingest(SESSION_ID, permissionResolved(5));
    gateway.ingest(SESSION_ID, turnComplete(6));

    await settle();

    const healed = snapshotOf(gateway);
    assert.equal(healed.control.phase, "completedSuccess", "回填后必须排空到回合终态");
    assert.equal(healed.pendingInteractions.length, 0, "计划审批必须被清掉");
    // 现场仍然要留：回填成功不等于不该知道发生过空洞。
    assert.equal(errors.filter((record) => record.scope === "fault.rawSeq.gap").length, 1);
  } finally {
    gateway.dispose();
  }
});

test("回填不回来时，投影必须落到 error 而不是继续 running + 等待确认", async () => {
  const errors: ErrorRecord[] = [];
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    onError: (scope: string, _error: unknown, context?: Record<string, unknown>) => {
      errors.push({ scope, context });
    },
    // 持久日志里确实没有那条事件（eventStore 淘汰 / 别的 runtime 写的）。
    loadPersistedEvents: async () => ({ events: [], synthesized: false, sourceEventSeq: 6 }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "gap-desync-epoch",
    rawSequenceGapToleranceMs: GAP_TOLERANCE_MS,
  });
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionRequested());
    gateway.ingest(SESSION_ID, permissionResolved(5));
    gateway.ingest(SESSION_ID, turnComplete(6));

    await settle();

    const desynced = snapshotOf(gateway);
    // 用户报告的症状（转圈 + 等待确认）在这里必须消失。
    assert.notEqual(desynced.control.phase, "running", "失同步会话不得再显示为运行中");
    assert.equal(desynced.control.phase, "error");
    assert.equal(desynced.control.canStop, false);
    assert.equal(desynced.control.lastError?.code, "fault.projection.desynced");
    assert.equal(desynced.control.lastError?.recoverable, true);
  } finally {
    gateway.dispose();
  }
});

test("失同步标记之后迟到的真实事件仍能恢复 phase（标记可逆）", async () => {
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    onError: () => {},
    loadPersistedEvents: async () => ({ events: [], synthesized: false, sourceEventSeq: 6 }),
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "gap-reversible-epoch",
    rawSequenceGapToleranceMs: GAP_TOLERANCE_MS,
  });
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionRequested());
    gateway.ingest(SESSION_ID, permissionResolved(5));
    gateway.ingest(SESSION_ID, turnComplete(6));
    await settle();
    assert.equal(snapshotOf(gateway).control.phase, "error");

    // 缺口最终补齐：raw 4 到达后必须 drain 到终态，把 error 覆盖掉。
    gateway.ingest(SESSION_ID, permissionResolved(4));

    const recovered = snapshotOf(gateway);
    assert.equal(recovered.control.phase, "completedSuccess");
    assert.equal(recovered.pendingInteractions.length, 0);
  } finally {
    gateway.dispose();
  }
});

// ── SessionResumed 吞掉滞留事件 ──

const sessionResumed = (rawSeq: number) =>
  event(SessionEventType.SessionResumed, { resumed: true }, 5_000, rawSeq);

function planRejectionFrozenAt(gateway: ConversationV4Gateway, resumeRawSeq?: number) {
  gateway.ingest(SESSION_ID, turnStarted());
  gateway.ingest(SESSION_ID, toolScheduled());
  gateway.ingest(SESSION_ID, permissionRequested());
  // raw 4（PermissionResolved）丢失，5/6 只能滞留。
  gateway.ingest(SESSION_ID, permissionResolved(5));
  gateway.ingest(SESSION_ID, turnComplete(6));
  if (resumeRawSeq !== undefined) {
    gateway.ingest(SESSION_ID, sessionResumed(resumeRawSeq));
  }
  return snapshotOf(gateway);
}

test("SessionResumed 不得丢掉边界前的滞留事件（否则投影永久停在运行中+等待确认）", async () => {
  const { gateway, errors } = createGateway();
  try {
    const frozen = planRejectionFrozenAt(gateway, 7);
    await settle();

    // 边界重置了，但 PermissionResolved / TurnComplete 是本进程已经收到的事实，
    // 必须落地：回合收口、pending 清空，列表上的转圈和「等待确认」一起消失。
    assert.equal(frozen.control.phase, "completedSuccess");
    assert.equal(frozen.pendingInteractions.length, 0);
    // 事件已被应用，不需要再把投影标成失同步。
    assert.equal(frozen.control.lastError?.code, undefined);
    assert.deepEqual(errors, [], "滞留事件被正常应用，不该报空洞现场");
  } finally {
    gateway.dispose();
  }
});

test("SessionResumed 之后新 epoch 的事件仍能正常连续 drain", () => {
  const { gateway } = createGateway();
  try {
    planRejectionFrozenAt(gateway, 7);
    // 新 epoch：raw 8 连续（7 已被 resume 消费），必须正常落地。
    gateway.ingest(
      SESSION_ID,
      event(SessionEventType.SessionTitleUpdated, { title: "新标题", source: "user" }, 6_000, 8),
    );
    const snapshot = snapshotOf(gateway);
    assert.equal(snapshot.control.phase, "completedSuccess");
    assert.equal(snapshot.meta.title, "新标题");
  } finally {
    gateway.dispose();
  }
});

test("没有空洞时的 SessionResumed 不改变任何既有事实", () => {
  const { gateway } = createGateway();
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionRequested());
    gateway.ingest(SESSION_ID, permissionResolved());
    gateway.ingest(SESSION_ID, turnComplete());
    const before = snapshotOf(gateway);
    assert.equal(before.control.phase, "completedSuccess");

    gateway.ingest(SESSION_ID, sessionResumed(6));

    const after = snapshotOf(gateway);
    assert.equal(after.control.phase, "completedSuccess");
    assert.equal(after.pendingInteractions.length, 0);
  } finally {
    gateway.dispose();
  }
});
