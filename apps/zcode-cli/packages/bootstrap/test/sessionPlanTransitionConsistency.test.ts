import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  type ConversationDelta,
  type SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// planTransition 是单次工具切档回执，不是可重放的历史流水（docs/specs/agent-mode-axis.md）：
// - 回执方向必须与同一份快照的权威 config.mode === "plan" 一致，冲突即丢弃；
// - 工具切档（source: "tool" 且带 toolCallId）生成方向由 mode 派生的新回执；
// - 非工具来源沿用旧回执前必须校验方向。否则快照会同时携带 mode: "yolo" 和
//   planEnabled: true 的旧回执，未消费过该 ID 的客户端（外部版独立 localStorage）
// 会把历史「进入 Plan」回执当成新事件，把输入框拉回 Plan 并带进下一次提交。

const SESSION_ID = "session-plan-transition-consistency";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;

function modeEvent(payload: Record<string, unknown>, offsetMs = 0): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-plan-transition-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: "turn-plan-transition",
    type: SessionEventType.SessionModeChanged,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-plan-transition",
    sequenceNumber,
    payload: {
      mode: payload.mode,
      previousMode: payload.previousMode ?? "yolo",
      source: "command",
      ...payload,
    },
  } as unknown as SessionEvent;
}

function projection(): ProductProjection {
  return new ProductProjection(SESSION_ID, "epoch-plan-transition");
}

function configOf(target: ProductProjection) {
  return target.getSnapshot().config;
}

function lastPatchConfig(deltas: ConversationDelta[]): SessionConfigState | undefined {
  let config: SessionConfigState | undefined;
  for (const delta of deltas) {
    if (delta.op === "state.updated" && delta.patch.config) config = delta.patch.config;
  }
  return config;
}

test("工具切进 Plan：快照携带带 toolCallId 的进入回执", () => {
  const target = projection();
  target.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
  );

  assert.equal(configOf(target).mode, "plan");
  assert.deepEqual(configOf(target).planTransition, {
    toolCallId: "tool-enter-1",
    planEnabled: true,
  });
});

test("回执方向由 mode 派生，不读兼容布尔位", () => {
  const target = projection();
  // 旧日志可能携带自相矛盾的布尔位；新回执必须按权威 mode 派生方向。
  target.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-2", planEnabled: false }, 1),
  );

  assert.deepEqual(configOf(target).planTransition, {
    toolCallId: "tool-enter-2",
    planEnabled: true,
  });
});

test("命令切离 Plan：方向冲突的进入回执被丢弃，快照与 delta 均不携带", () => {
  const target = projection();
  target.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
  );
  const deltas = target.applyEvent(modeEvent({ mode: "yolo", previousMode: "plan" }, 2));

  assert.equal(configOf(target).mode, "yolo");
  assert.equal(configOf(target).planTransition, undefined);
  assert.equal(lastPatchConfig(deltas)?.planTransition, undefined);
});

test("命令切到 readonly / team：同样丢弃方向冲突的进入回执", () => {
  const readonlyTarget = projection();
  readonlyTarget.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
  );
  readonlyTarget.applyEvent(modeEvent({ mode: "readonly", previousMode: "plan" }, 2));
  assert.equal(configOf(readonlyTarget).planTransition, undefined);

  const teamTarget = projection();
  teamTarget.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
  );
  teamTarget.applyEvent(modeEvent({ mode: "team", previousMode: "plan" }, 2));
  assert.equal(configOf(teamTarget).planTransition, undefined);
});

test("清掉回执后重复同档命令：幂等，不再产生 delta", () => {
  const target = projection();
  target.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
  );
  target.applyEvent(modeEvent({ mode: "yolo", previousMode: "plan" }, 2));
  const revision = target.getSnapshot().revision;

  const deltas = target.applyEvent(modeEvent({ mode: "yolo", previousMode: "plan" }, 3));

  assert.deepEqual(deltas, []);
  assert.equal(target.getSnapshot().revision, revision);
});

test("工具退出 Plan：仍携带带 toolCallId 的退出回执", () => {
  const target = projection();
  target.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
  );
  target.applyEvent(
    modeEvent(
      { mode: "yolo", previousMode: "plan", source: "tool", toolCallId: "tool-exit-1" },
      2,
    ),
  );

  assert.equal(configOf(target).mode, "yolo");
  assert.deepEqual(configOf(target).planTransition, {
    toolCallId: "tool-exit-1",
    planEnabled: false,
  });
});

test("命令进入 Plan：方向冲突的旧退出回执被丢弃", () => {
  const target = projection();
  target.applyEvent(
    modeEvent(
      { mode: "yolo", previousMode: "plan", source: "tool", toolCallId: "tool-exit-1" },
      1,
    ),
  );
  target.applyEvent(modeEvent({ mode: "plan", previousMode: "yolo" }, 2));

  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planTransition, undefined);
});

test("带完全访问授权的退出：授权标记照常更新，回执被清掉", () => {
  const target = projection();
  target.applyEvent(
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
  );
  const deltas = target.applyEvent(
    modeEvent(
      {
        mode: "yolo",
        previousMode: "plan",
        planEnabled: false,
        permissionGrant: { interactionId: "grant-1", queueItemIds: ["queue-1"] },
      },
      2,
    ),
  );

  const config = configOf(target);
  assert.equal(config.mode, "yolo");
  assert.equal(config.permissionGrant?.interactionId, "grant-1");
  assert.equal(config.planTransition, undefined);
  assert.equal(lastPatchConfig(deltas)?.permissionGrant?.interactionId, "grant-1");
});

test("冷恢复重放同一事件序列：终态与 live 一致", () => {
  const events = [
    modeEvent({ mode: "plan", source: "tool", toolCallId: "tool-enter-1", planEnabled: true }, 1),
    modeEvent({ mode: "yolo", previousMode: "plan" }, 2),
    modeEvent({ mode: "plan", previousMode: "yolo" }, 3),
    modeEvent({ mode: "yolo", previousMode: "plan" }, 4),
  ];

  const live = projection();
  for (const event of events) live.applyEvent(event);
  const replay = projection();
  for (const event of events) replay.applyEvent(event);

  assert.deepEqual(configOf(replay), configOf(live));
  assert.equal(configOf(replay).planTransition, undefined);
});
