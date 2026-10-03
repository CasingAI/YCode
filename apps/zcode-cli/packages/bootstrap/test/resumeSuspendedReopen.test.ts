import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 同 turn 续跑的投影契约（docs/specs/session-error-banner-continue.md §4.1/§4.3）：
// 点「继续」后 core 发来的 TurnResumed 事件带的是**失败轮那个 turnId**，投影不新增
// turnHeader 行，只把失败那行从 failed 翻回 running 并清 lastError —— 时间线上是同一个
// 块接着长。幂等：只有 failed 能被复活，连点第二次不产生任何 delta。

const T0 = 1_700_000_000_000;
const SESSION_ID = "sess-resume-in-place";

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

function headers(projection: ProductProjection): TurnHeaderRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row): row is TurnHeaderRow => row.kind === "turnHeader");
}

function failTurn(projection: ProductProjection, turnId: string, at: number): void {
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: 1,
        input: "原文",
        messageId: `msg-${turnId}`,
        executionKind: "agent",
        intent: {
          sourceCommandId: `cmd-${turnId}`,
          queueItemId: `q-${turnId}`,
          clientId: "client-1",
          kind: "sendText",
          admissionSeq: 0,
          admittedAt: at,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      at,
      turnId,
    ),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnError,
      {
        error: {
          type: "fault.runtime.unknown",
          code: "model_rate_limited",
          message: "Output token rate limit exceeded",
        },
        turnPhase: "regular_turn_loop",
      },
      at + 1_000,
      turnId,
    ),
  );
}

test("TurnResumed 把失败轮原地翻回 running：同一行、清 lastError、不新增 header", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  failTurn(projection, "turn-1", T0);

  const failed = headers(projection)[0];
  assert.equal(failed?.state, "failed");
  assert.ok(projection.getSnapshot().control.lastError);

  // 事件 turnId 就是失败轮那个 —— 没有新轮，也就没有第二个 turnHeader。
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnResumed,
      { userMessageId: "msg-turn-1" },
      T0 + 2_000,
      "turn-1",
    ),
  );

  const rows = headers(projection);
  assert.equal(rows.length, 1, "续跑不得新增 turnHeader 行");
  assert.equal(rows[0]?.rowId, failed?.rowId);
  assert.equal(rows[0]?.state, "running");
  // 工时连续：失败时刻结算的终态被清掉，续跑期间计时继续涨。
  assert.equal(rows[0]?.endedAt, undefined);
  assert.equal(rows[0]?.activeMs, undefined);
  const segments = rows[0]?.workSegments ?? [];
  assert.equal(segments.length, 1);
  assert.equal(segments[segments.length - 1]?.endedAt, undefined);

  const control = projection.getSnapshot().control;
  assert.equal(control.lastError, null, "横幅消失的唯一依据");
  assert.equal(control.phase, "running");
  assert.equal(control.canStop, true);
});

test("TurnResumed 幂等：非 failed 的轮不会被再次复活", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  failTurn(projection, "turn-1", T0);
  const resumed = makeEvent(
    SessionEventType.TurnResumed,
    { userMessageId: "msg-turn-1" },
    T0 + 2_000,
    "turn-1",
  );
  projection.applyEvent(resumed);
  const afterFirst = headers(projection)[0];

  // 连点第二次：失败轮已经翻回 running，第二次必须零 delta。
  projection.applyEvent(resumed);
  assert.equal(headers(projection)[0]?.rowId, afterFirst?.rowId);
  assert.equal(headers(projection)[0]?.state, "running");
  assert.equal(headers(projection).length, 1);
});

test("续跑后再次失败：同一行回到 failed，横幅与按钮重新可点", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  failTurn(projection, "turn-1", T0);
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnResumed,
      { userMessageId: "msg-turn-1" },
      T0 + 2_000,
      "turn-1",
    ),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnError,
      { error: { type: "fault.runtime.unknown", message: "network down" }, turnPhase: "streaming" },
      T0 + 3_000,
      "turn-1",
    ),
  );

  const rows = headers(projection);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "failed");
  assert.ok(projection.getSnapshot().control.lastError);
});

// 冷恢复场景（spec §4.3「轮次映射必须与 header 一起登记」）：失败轮是上次进程
// hydrate 合成的，界面上的轮次身份是持久 user messageId，而 core 复刻的是转录里真实的
// runtime turnId —— 续跑时这两个本来就不同。此前 TurnResumed 靠 payload.userMessageId
// 翻回了 header，却没有登记 runtime→product 映射，续跑回来的产出就落进一个凭空多出来的
// 幽灵轮次：转圈等按 header 判定的 UI 全部失效（后端在跑、界面显示未运行）。
test("冷恢复轮续跑：起跑与续跑的 runtimeTurnId 不同，产出仍归回原 header 的轮次", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  const HYDRATE_TURN = "hydrate-turn-7";
  const RESUME_TURN = "turn_c246fc42-7b22-444b-ba02-5b10482b78fb";
  const PRODUCT_TURN = "msg-mupwuajt-239f330f";

  // 上次进程冷恢复合成的一轮：事件 turnId 是一次性 hydrate id，界面身份 = 持久 messageId。
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: 7,
        input: "原文",
        messageId: PRODUCT_TURN,
        executionKind: "agent",
        intent: {
          sourceCommandId: "cmd-1",
          queueItemId: "q-1",
          clientId: "client-1",
          kind: "sendText",
          admissionSeq: 0,
          admittedAt: T0,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      },
      T0,
      HYDRATE_TURN,
    ),
  );
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnError,
      {
        error: {
          type: "fault.runtime.unknown",
          code: "model_rate_limited",
          message: "Output token rate limit exceeded",
        },
        turnPhase: "regular_turn_loop",
      },
      T0 + 1_000,
      HYDRATE_TURN,
    ),
  );
  assert.equal(headers(projection)[0]?.turnId, PRODUCT_TURN);

  // 点「继续」：core 发来的 TurnResumed 带的是转录里真实的 runtime turnId。
  projection.applyEvent(
    makeEvent(
      SessionEventType.TurnResumed,
      { userMessageId: PRODUCT_TURN },
      T0 + 2_000,
      RESUME_TURN,
    ),
  );

  // 续跑回来的模型产出。
  for (const [index, kind] of (["text_start", "text_delta", "text_end"] as const).entries()) {
    projection.applyEvent(
      makeEvent(
        SessionEventType.ModelStreaming,
        { kind, delta: kind === "text_delta" ? "接着跑" : undefined },
        T0 + 3_000 + index,
        RESUME_TURN,
      ),
    );
  }

  const window = projection.getSnapshot().rows.window;
  assert.equal(headers(projection).length, 1, "续跑不得新增 turnHeader 行");
  assert.equal(headers(projection)[0]?.state, "running");
  // 关键断言：产出必须回到原 header 的轮次，不能裂出一个用 runtimeTurnId 命名的新轮。
  assert.ok(
    window.every((row) => row.turnId === PRODUCT_TURN),
    `产出裂到了别的轮次：${[...new Set(window.map((row) => row.turnId))].join(", ")}`,
  );
  assert.ok(
    window.some((row) => row.kind === "assistantText"),
    "续跑产出应当落在同一个 turnHeader 之下",
  );
});