import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizePlanFileWrittenEvents } from "../src/zcode-protocol-v4/plan-file-hydration.js";

// ExitPlanMode 的计划落盘路径只有一条来源：`plan_file_written` 事件投影到工具行上的
// `planFilePath`。它不能走工具输出——v4 UI 静默拒绝计划批准，拒绝路径连输出都没有，
// 所以这两条必须锁住：直播事件与冷恢复合成事件都要能落到同一条行上。

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-plan-file";

let seq = 0;
function makeEvent(
  type: SessionEventType,
  payload: unknown,
  timestampMs: number,
  turnId = "turn-1",
): SessionEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sessionId: SESSION_ID,
    turnId,
    type,
    timestamp: new Date(timestampMs),
    traceId: "trace-1",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

const PLAN_FILE_PATH = "/workspace/.zcode/plans/sess-plan-file/20260102-030405678-call-1.md";

function startRunningTurnWithExitPlanMode(projection: ProductProjection): void {
  projection.applyEvent(
    makeEvent(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi", executionKind: "agent" }, T0),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call-1",
        assistantMessageId: "msg-1",
        toolName: "ExitPlanMode",
        input: { overview: "概述", plan: "# 计划\n正文", title: "计划" },
        schedule: { parallelGroups: [["call-1"]], executionOrder: ["call-1"] },
      },
      T0 + 1_000,
    ),
  );
}

function planFileWrittenEvent(path: string, toolCallId = "call-1"): SessionEvent {
  return makeEvent(
    SessionEventType.PlanFileWritten,
    { planFilePath: path, planId: path.split("/").pop()!.replace(/\.md$/, ""), toolCallId },
    T0 + 2_000,
  );
}

function toolRows(projection: ProductProjection): ToolCallRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is ToolCallRow => row.kind === "toolCall");
}

// 每次 applyEvent 都会带一条 state.updated（revision 自增），与本事件是否改行无关；
// 关心「改没改行」的断言必须只看行级 delta。
function rowUpserts(deltas: ReturnType<ProductProjection["applyEvent"]>): unknown[] {
  return deltas.filter((delta) => delta.op === "row.upserted" || delta.op === "row.appended");
}

test("落盘事件把路径补到 ExitPlanMode 行上，其余字段不动", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  startRunningTurnWithExitPlanMode(projection);
  const before = toolRows(projection)[0];
  assert.equal(before?.planFilePath, undefined);

  const deltas = projection.applyEvent(planFileWrittenEvent(PLAN_FILE_PATH));

  assert.equal(rowUpserts(deltas).length, 1);
  const after = toolRows(projection)[0];
  assert.equal(after?.planFilePath, PLAN_FILE_PATH);
  // 路径是补在既有行上的展示事实：入参、输入文本、身份键都不能被它改写
  assert.equal(after?.rowId, before?.rowId);
  assert.deepEqual(after?.input, before?.input);
  assert.equal(after?.inputText, before?.inputText);
});

test("同一路径重复投影是幂等的，未知 toolCallId 不凭空造行", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  startRunningTurnWithExitPlanMode(projection);
  assert.equal(rowUpserts(projection.applyEvent(planFileWrittenEvent(PLAN_FILE_PATH))).length, 1);
  // 冷恢复会同时拿到 live 事件与目录重推导的事件，两条同值必须只改一次行
  assert.equal(rowUpserts(projection.applyEvent(planFileWrittenEvent(PLAN_FILE_PATH))).length, 0);

  // 没有对应工具行（例如该轮不在投影窗口内）时丢弃：路径只补事实，不造行
  assert.equal(
    rowUpserts(projection.applyEvent(planFileWrittenEvent(PLAN_FILE_PATH, "call-missing"))).length,
    0,
  );
  assert.equal(toolRows(projection).length, 1);
});

test("冷恢复合成的事件与 live 同型，落到同一条行上", () => {
  const facts = [{ planId: "20260102-030405678-call-1", toolCallId: "call-1", path: PLAN_FILE_PATH }];
  const events = synthesizePlanFileWrittenEvents({ facts, sessionId: SESSION_ID });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, SessionEventType.PlanFileWritten);
  // 确定性 id：同一次冷恢复重复执行不会产生第二条事件
  assert.equal(events[0]?.id, "hydrate-plan-file-20260102-030405678-call-1");
  assert.equal(events[0]?.sessionId, SESSION_ID);
  assert.deepEqual(events[0]?.payload, {
    planFilePath: PLAN_FILE_PATH,
    planId: "20260102-030405678-call-1",
    toolCallId: "call-1",
  });

  // 冷恢复的行由 transcript 重建、路径由目录重推导，两者经同一个 reducer 归到同一行
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  startRunningTurnWithExitPlanMode(projection);
  for (const event of events) projection.applyEvent(event);
  assert.equal(toolRows(projection)[0]?.planFilePath, PLAN_FILE_PATH);
});
