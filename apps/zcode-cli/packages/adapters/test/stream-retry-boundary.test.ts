import assert from "node:assert/strict";
import test from "node:test";
import type { ModelStreamEvent } from "@zcode/contracts";
import { toResponsesLifecycleEvent } from "../src/model/responses-stream-lifecycle.js";
import { applyStreamEventsToRetryBoundary } from "../src/model/stream-retry-boundary.js";

function phaseEvent(type: "reasoning_phase_start" | "reasoning_phase_end"): ModelStreamEvent {
  return {
    type,
    attemptId: "request-1:1",
    observedAt: 10,
    responseId: "response-1",
    ...(type === "reasoning_phase_end" ? { phaseEndReason: "text" as const } : {}),
  };
}

test("Responses 思考阶段即时可见且不提交重试边界", () => {
  const pendingRetrySafeEvents: ModelStreamEvent[] = [];
  const start = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: false,
    events: [phaseEvent("reasoning_phase_start")],
    pendingRetrySafeEvents,
  });

  assert.deepEqual(
    start.visibleEvents.map((event) => event.type),
    ["reasoning_phase_start"],
  );
  assert.equal(start.emittedRetryBoundaryEvent, false);
  assert.deepEqual(pendingRetrySafeEvents, []);

  const end = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: start.emittedRetryBoundaryEvent,
    events: [phaseEvent("reasoning_phase_end")],
    pendingRetrySafeEvents,
  });
  assert.deepEqual(
    end.visibleEvents.map((event) => event.type),
    ["reasoning_phase_end"],
  );
  assert.equal(end.emittedRetryBoundaryEvent, false);
});

test("Responses lifecycle 只接纳带 response id 的公开边界", () => {
  const start = toResponsesLifecycleEvent(
    { type: "raw", rawValue: { type: "response.in_progress", response: { id: "resp-1" } } },
    "request-1:1",
    10,
  );
  assert.deepEqual(start, {
    type: "reasoning_phase_start",
    attemptId: "request-1:1",
    observedAt: 10,
    responseId: "resp-1",
  });

  assert.equal(
    toResponsesLifecycleEvent(
      { type: "raw", rawValue: { type: "response.in_progress", response: {} } },
      "request-1:1",
      10,
    ),
    undefined,
  );
});

test("思考阶段可见时，普通 retry-safe 前奏仍等到 provider 提交边界", () => {
  const pendingRetrySafeEvents: ModelStreamEvent[] = [];
  const phase = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: false,
    events: [phaseEvent("reasoning_phase_start")],
    pendingRetrySafeEvents,
  });
  const prelude: ModelStreamEvent = { type: "text_start", id: "text-1" };
  const buffered = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: phase.emittedRetryBoundaryEvent,
    events: [prelude],
    pendingRetrySafeEvents,
  });

  assert.deepEqual(buffered.visibleEvents, []);
  assert.deepEqual(pendingRetrySafeEvents, [prelude]);
  assert.equal(buffered.emittedRetryBoundaryEvent, false);

  const committed: ModelStreamEvent = { type: "text_delta", text: "hello" };
  const flushed = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: buffered.emittedRetryBoundaryEvent,
    events: [committed],
    pendingRetrySafeEvents,
  });
  assert.deepEqual(flushed.visibleEvents, [prelude, committed]);
  assert.equal(flushed.emittedRetryBoundaryEvent, true);
});
