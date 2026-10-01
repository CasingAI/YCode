// raw seq 空洞导致会话投影永久冻结的回归测试。
//
// 背景：core 的 appendEvent 先由 eventStore 分配 raw sequenceNumber，再依次
// persistDurableSessionEvent → recordToolUsageFromEvent → notifyEventSinks
// （core/src/runtime/methods/events.ts:102-147）。任一后续步骤抛错都会 rethrow，
// 该序号已被消耗却永远不会进入 live sink。v4-gateway 的
// normalizeRuntimeEventSequence（v4-gateway.ts:3244-3265）只按 raw seq 连续 drain，
// 缺一环则其后所有事件（含 PermissionResolved / TurnComplete）永久滞留在
// pendingByRawSeq，没有 gap 超时、也没有自愈。
//
// 后果与用户报告的现象完全一致：投影冻结在 Plan 被拒绝之前的快照——
// control.phase 仍是 running（列表转圈）、pendingInteractions 仍有那条计划审批
// （列表显示「等待确认」），而实际上回合早已结束、没有任何东西在跑。
//
// 本文件锁定「空洞造成的那份冻结快照长什么样」；缺口确认、回填自愈与冻结暴露
// 见 rawSeqGapRecovery.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import type { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

const SESSION_ID = "session-raw-gap";
const TURN_ID = "turn-raw-gap";
const TOOL_CALL_ID = "call-exit-plan";
const REQUEST_ID = "request-plan-approval";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;
function event(
  type: SessionEventType,
  payload: unknown,
  offsetMs: number,
  rawSeq: number,
): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-gap-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-raw-gap",
    // raw seq 由 eventStore 分配，与数组下标无关：这里显式指定才能制造空洞。
    sequenceNumber: rawSeq,
    payload,
  } as unknown as SessionEvent;
}

interface GatewayTestAccess {
  publishers: Map<string, ConversationTopicPublisher>;
}

function createGateway(): ConversationV4Gateway {
  const host = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    onError: () => {},
  } as unknown as V4GatewayHost;
  return new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "gap-epoch",
  });
}

function snapshotOf(gateway: ConversationV4Gateway) {
  const publisher = (gateway as unknown as GatewayTestAccess).publishers.get(SESSION_ID);
  assert.ok(publisher, "会话 publisher 应已建立");
  return publisher.getSnapshot();
}

const turnStarted = () =>
  event(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "写计划", executionKind: "agent" },
    0,
    1,
  );
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

test("确认窗口内，缺失的 raw seq 让投影停在运行中+等待确认（用户报告的那一行）", () => {
  const gateway = createGateway();
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionRequested());

    const waiting = snapshotOf(gateway);
    assert.equal(waiting.control.phase, "running");
    assert.equal(waiting.pendingInteractions.length, 1);

    // raw 4（PermissionResolved）在 notify 之前丢失：它的序号已被 eventStore 消耗，
    // 却永远不会到达 live sink。raw 5/6 到达后只能滞留在 pendingByRawSeq。
    gateway.ingest(SESSION_ID, permissionResolved(5));
    gateway.ingest(SESSION_ID, turnComplete(6));

    const frozen = snapshotOf(gateway);
    // 这三条断言就是用户截图那一行：转圈（running）+ 等待确认，且不会自愈。
    assert.equal(frozen.control.phase, "running");
    assert.equal(frozen.pendingInteractions.length, 1);
    assert.equal(frozen.pendingInteractions[0]?.payload.kind, "userInput");

    // 任何后续事件本身都解不开缺口：每条都被挡在缺口之后。此时
    // control.phase 仍是 running、pendingInteractions 仍有那条计划审批，
    // 正是用户截图里的那一行。确认窗口之后由 rawSeqGapRecovery.test.ts
    // 覆盖：回填自愈，或退到 error 而不是继续撒谎。
    gateway.ingest(SESSION_ID, permissionRequested());
    gateway.ingest(
      SESSION_ID,
      event(SessionEventType.SessionTitleUpdated, { title: "x", source: "user" }, 5_000, 7),
    );
    const stillFrozen = snapshotOf(gateway);
    assert.equal(stillFrozen.control.phase, "running");
    assert.equal(stillFrozen.pendingInteractions.length, 1);
  } finally {
    gateway.dispose();
  }
});

test("迟到的缺口事件补齐后，冻结的投影必须一路排空到回合终态", () => {
  const gateway = createGateway();
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    gateway.ingest(SESSION_ID, permissionResolved());
    gateway.ingest(SESSION_ID, turnComplete());

    const frozen = snapshotOf(gateway);
    assert.equal(frozen.control.phase, "running", "缺口未补齐前应保持冻结");

    // 缺口事件迟到：raw 3 补上后，4 和 5 必须被连续 drain 一起放行。
    gateway.ingest(SESSION_ID, permissionRequested());

    const thawed = snapshotOf(gateway);
    assert.equal(thawed.control.phase, "completedSuccess");
    assert.equal(thawed.pendingInteractions.length, 0);
  } finally {
    gateway.dispose();
  }
});

test("缺口补齐后不得重放已应用事件（按 event.id 去重）", () => {
  const gateway = createGateway();
  try {
    gateway.ingest(SESSION_ID, turnStarted());
    gateway.ingest(SESSION_ID, toolScheduled());
    const requested = permissionRequested();
    gateway.ingest(SESSION_ID, permissionResolved());
    gateway.ingest(SESSION_ID, turnComplete());
    gateway.ingest(SESSION_ID, requested);
    gateway.ingest(SESSION_ID, requested);

    const thawed = snapshotOf(gateway);
    assert.equal(thawed.control.phase, "completedSuccess");
    assert.equal(thawed.pendingInteractions.length, 0);
    const toolRows = thawed.rows.window.filter((row) => row.kind === "toolCall");
    assert.equal(toolRows.length, 1, "同一事件重放不得让工具行重复");
  } finally {
    gateway.dispose();
  }
});
