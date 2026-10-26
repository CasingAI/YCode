import assert from "node:assert/strict";
import test from "node:test";
import {
  CompactTimelineStatus,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
} from "@zcode/contracts";
import type { TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

const T0 = 1_700_000_000_000;
const SESSION_ID = "session-compact-marker-lifecycle";
const TURN_ID = "turn-compact-marker-lifecycle";
const OPERATION_ID = "compact-op-lifecycle";

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-compact-marker-lifecycle",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function compactEvent(
  type: SessionEventType,
  status: CompactTimelineStatus,
  offsetMs: number,
): SessionEvent {
  return event(
    type,
    {
      operationId: OPERATION_ID,
      messageId: `message-${OPERATION_ID}`,
      partId: `part-${OPERATION_ID}`,
      status,
      trigger: "manual",
      display: "separator",
      phase: "standalone_turn",
    },
    offsetMs,
  );
}

function compactRows(projection: ProductProjection): TimelineMarkerRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter(
      (row): row is TimelineMarkerRow =>
        row.kind === "timelineMarker" && row.marker.type === "compact",
    );
}

function userMessage(): MessageWithParts {
  return {
    info: {
      id: "user-compact-marker",
      sessionID: SESSION_ID,
      role: "user",
      time: { created: T0 + 500 },
      metadata: { executionKind: "agent" },
    },
    parts: [
      {
        id: "part-user-compact-marker",
        sessionID: SESSION_ID,
        messageID: "user-compact-marker",
        type: "text",
        text: "压缩一下上下文",
      },
    ],
  } as unknown as MessageWithParts;
}

function compactStatusOf(row: TimelineMarkerRow | undefined): string | undefined {
  return row?.kind === "timelineMarker" && row.marker.type === "compact"
    ? row.marker.status
    : undefined;
}

function compactFacts(projection: ProductProjection) {
  const snapshot = projection.getSnapshot();
  const rows = compactRows(projection);
  return {
    markerCount: rows.length,
    markerStatuses: rows.map((row) => compactStatusOf(row)),
    compactWorkKinds: snapshot.control.activeWorks
      .filter((work) => work.kind === "compact")
      .map((work) => work.kind),
    activeWorkKinds: snapshot.control.activeWorks.map((work) => work.kind),
    canStop: snapshot.control.canStop,
    stopState: snapshot.control.stopState,
    stopTargetKind: snapshot.control.stopTargetKind,
    compactAllowed: snapshot.availability.compact.allowed,
    compactReasonCode: snapshot.availability.compact.allowed
      ? null
      : snapshot.availability.compact.reasonCode,
    forkReasonCode: snapshot.availability.fork.allowed
      ? null
      : snapshot.availability.fork.reasonCode,
    inputRoutingMode: snapshot.inputRouting.mode,
  };
}

const TERMINAL_CASES: ReadonlyArray<{
  label: string;
  status: CompactTimelineStatus;
  expectedMarkerStatus: "failed" | "cancelled";
}> = [
  { label: "failed", status: CompactTimelineStatus.Failed, expectedMarkerStatus: "failed" },
  {
    label: "interrupted",
    status: CompactTimelineStatus.Interrupted,
    expectedMarkerStatus: "cancelled",
  },
];

for (const terminalCase of TERMINAL_CASES) {
  test(`CompactStarted → CompactFailed(${terminalCase.label}) 复用同一 marker row 并复位 compact 状态`, () => {
    const projection = new ProductProjection(SESSION_ID, "epoch-compact-marker");
    projection.applyEvent(
      compactEvent(SessionEventType.CompactStarted, CompactTimelineStatus.Started, 0),
    );

    const runningRows = compactRows(projection);
    assert.equal(runningRows.length, 1);
    assert.equal(compactStatusOf(runningRows[0]), "running");
    const rowId = runningRows[0]?.rowId;
    const running = projection.getSnapshot();
    assert.deepEqual(
      running.control.activeWorks.map((work) => work.kind),
      ["compact"],
    );
    assert.equal(running.control.canStop, true);
    assert.equal(running.control.stopState, "stoppable");
    assert.equal(running.control.stopTargetKind, "compact");
    assert.equal(
      running.availability.compact.allowed === false
        ? running.availability.compact.reasonCode
        : null,
      "compactOperationLock",
    );
    assert.equal(
      running.availability.fork.allowed === false ? running.availability.fork.reasonCode : null,
      "compactOperationLock",
    );
    assert.equal(running.inputRouting.mode, "enqueue");

    projection.applyEvent(compactEvent(SessionEventType.CompactFailed, terminalCase.status, 1_000));

    const terminalRows = compactRows(projection);
    assert.equal(terminalRows.length, 1, "同一 operationId 只保留一行 marker");
    assert.equal(terminalRows[0]?.rowId, rowId, "终态必须原地更新 started 的 marker row");
    assert.equal(compactStatusOf(terminalRows[0]), terminalCase.expectedMarkerStatus);

    const terminal = projection.getSnapshot();
    assert.deepEqual(
      terminal.control.activeWorks.filter((work) => work.kind === "compact"),
      [],
    );
    assert.equal(terminal.control.canStop, false);
    assert.equal(terminal.control.stopState, "idle");
    assert.equal(terminal.control.stopTargetKind, "unknown");
    // 没有活动 turn 时 compact 回落为 idleCannotCompact；关键是不再被
    // compactOperationLock 卡住（与 activeWorks 同源）。
    assert.equal(
      terminal.availability.compact.allowed === false
        ? terminal.availability.compact.reasonCode
        : null,
      "idleCannotCompact",
    );
    assert.notEqual(
      terminal.availability.fork.allowed === false ? terminal.availability.fork.reasonCode : null,
      "compactOperationLock",
    );
    assert.notEqual(terminal.inputRouting.mode, "enqueue");
  });
}

test("冷恢复回放 CompactStarted → CompactFailed 与 live 投影一致且不遗留 running", () => {
  const merged = mergeColdConversationEvents({
    sessionId: SESSION_ID,
    // 不造同 operationId 的 transcript compact part：否则 cold-event-merge 会把
    // 内存事件当作 durable boundary 重复项抑制，测不到回放路径。
    messages: [userMessage()],
    memoryEvents: [
      compactEvent(SessionEventType.CompactStarted, CompactTimelineStatus.Started, 1_000),
      compactEvent(SessionEventType.CompactFailed, CompactTimelineStatus.Failed, 2_000),
    ],
  });

  const replayed = new ProductProjection(SESSION_ID, "epoch-cold-compact-marker");
  for (const mergedEvent of merged.events) replayed.applyEvent(mergedEvent);

  const live = new ProductProjection(SESSION_ID, "epoch-live-compact-marker");
  live.applyEvent(
    event(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "压缩一下上下文", executionKind: "agent" },
      0,
    ),
  );
  // transcript 合成用户轮时会补一条 TurnComplete（空响应也算完成），
  // live 侧保持同形，避免把“轮次是否活动”误当 compact 投影差异。
  live.applyEvent(
    event(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        historyRoundCount: 0,
        duration: 0,
        resultType: "success",
      },
      900,
    ),
  );
  live.applyEvent(
    compactEvent(SessionEventType.CompactStarted, CompactTimelineStatus.Started, 1_000),
  );
  live.applyEvent(
    compactEvent(SessionEventType.CompactFailed, CompactTimelineStatus.Failed, 2_000),
  );

  assert.deepEqual(compactFacts(replayed), compactFacts(live));
  assert.equal(compactRows(replayed).length, 1);
  assert.equal(
    compactStatusOf(compactRows(replayed)[0]),
    "failed",
    "冷恢复后 marker 必须落到 failed，不能停留在 running",
  );
  assert.equal(
    replayed.getSnapshot().control.activeWorks.some((work) => work.kind === "compact"),
    false,
  );
  const replayedAvailability = replayed.getSnapshot().availability;
  assert.notEqual(
    replayedAvailability.compact.allowed === false ? replayedAvailability.compact.reasonCode : null,
    "compactOperationLock",
    "compactOperationLock 必须随 activeWork 清除而复位",
  );
});
