import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { sessionConfigStateSchema } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 计划执行目标（planExecuteMode）是 Plan 内的单值附注，不是第五档：
// - 真值由 runtime 在进入/离开 Plan 的写入点派生，投影只负责透传事件值与冷启动种子；
// - 字段仅 mode === "plan" 有效；离开 Plan 必须清理；
// - 旧事件/旧种子缺字段按 "yolo" 兼容，不从 previousMode 猜，也绝不恢复 readonly。
// 这些用例直接驱动 reducer 与 seedConfig，锁住 live 事件、冷恢复重放、种子与幂等四类路径。

const SESSION_ID = "session-plan-execute-mode";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;

function modeEvent(payload: Record<string, unknown>, offsetMs = 0): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-plan-execute-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: "turn-plan-execute-mode",
    type: SessionEventType.SessionModeChanged,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-plan-execute-mode",
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
  return new ProductProjection(SESSION_ID, "epoch-plan-execute-mode");
}

function configOf(target: ProductProjection) {
  return target.getSnapshot().config;
}

test("live SessionModeChanged：Plan + team 透传为权威计划执行目标", () => {
  const target = projection();
  const deltas = target.applyEvent(
    modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1),
  );

  assert.ok(deltas.length > 0);
  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planExecuteMode, "team");
});

test("协议兼容：投影后的 config 通过 v4 schema 且保留计划执行目标", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1));

  const parsed = sessionConfigStateSchema.safeParse(configOf(target));
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.mode, "plan");
  assert.equal(parsed.data?.planExecuteMode, "team");
});

test("live SessionModeChanged：同 mode 但目标变化必须产出 delta", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1));

  const deltas = target.applyEvent(
    modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "yolo" }, 2),
  );

  assert.ok(deltas.length > 0);
  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planExecuteMode, "yolo");
});

test("live SessionModeChanged：完全相同的 plan/team 重放是幂等的", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1));
  const revision = target.getSnapshot().revision;

  const deltas = target.applyEvent(
    modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 2),
  );

  // 同值重放不产任何 delta；seq 照常推进，但 revision 不因无可见变化而递增。
  assert.deepEqual(deltas, []);
  assert.equal(target.getSnapshot().revision, revision);
});

test("live SessionModeChanged：离开 Plan 清理目标字段", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1));
  target.applyEvent(modeEvent({ mode: "yolo", previousMode: "plan", planExecuteMode: "team" }, 2));

  assert.equal(configOf(target).mode, "yolo");
  assert.equal(configOf(target).planExecuteMode, undefined);
  assert.equal(Object.hasOwn(configOf(target), "planExecuteMode"), false);
});

test("live SessionModeChanged：旧事件缺目标字段时 Plan 内按 yolo 兼容", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true }, 1));

  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planExecuteMode, "yolo");
});

test("live SessionModeChanged：非法目标值不恢复 readonly，收敛为 yolo", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "readonly" }, 1));
  assert.equal(configOf(target).planExecuteMode, "yolo");

  target.applyEvent(
    modeEvent({ mode: "readonly", previousMode: "plan", planExecuteMode: "team" }, 2),
  );
  assert.equal(configOf(target).mode, "readonly");
  assert.equal(Object.hasOwn(configOf(target), "planExecuteMode"), false);
});

test("冷启动种子：Plan + team 直接写入 snapshot.config", () => {
  const target = projection();
  target.seedConfig({ mode: "plan", planExecuteMode: "team" });

  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planExecuteMode, "team");
});

test("冷启动种子：Plan 内缺目标字段按 yolo 兼容", () => {
  const target = projection();
  target.seedConfig({ mode: "plan" });

  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planExecuteMode, "yolo");
});

test("冷启动种子：非 Plan 清理目标字段", () => {
  const target = projection();
  target.seedConfig({ mode: "plan", planExecuteMode: "team" });
  target.seedConfig({ mode: "yolo" });

  assert.equal(configOf(target).mode, "yolo");
  assert.equal(Object.hasOwn(configOf(target), "planExecuteMode"), false);
});

test("冷启动种子：重复种同一份目标是幂等的（不换 snapshot、不 bump revision）", () => {
  const target = projection();
  target.seedConfig({ mode: "plan", planExecuteMode: "team" });
  const snapshot = target.getSnapshot();
  const revision = snapshot.revision;

  target.seedConfig({ mode: "plan", planExecuteMode: "team" });

  assert.equal(target.getSnapshot(), snapshot);
  assert.equal(target.getSnapshot().revision, revision);
});

test("事件优先：日志已触碰 mode 后种子不得改写计划执行目标", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1));

  target.seedConfig({ mode: "plan", planExecuteMode: "yolo" });

  assert.equal(configOf(target).planExecuteMode, "team");
});

test("冷恢复重放：先离开 Plan 再进入新 Plan 不残留上一次的 Team", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1));
  target.applyEvent(modeEvent({ mode: "yolo", previousMode: "plan" }, 2));
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, previousMode: "yolo" }, 3));

  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planExecuteMode, "yolo");
});

test("冷恢复重放：新 Plan 的 Team 目标在重放后保留", () => {
  const target = projection();
  target.applyEvent(modeEvent({ mode: "plan", planEnabled: true, planExecuteMode: "team" }, 1));
  // hydration 收尾会再种一次同源 runtime 真值；事件已触碰时种子不覆盖。
  target.seedConfig({ mode: "plan", planExecuteMode: "team" });

  assert.equal(configOf(target).mode, "plan");
  assert.equal(configOf(target).planExecuteMode, "team");
});
