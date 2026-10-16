import assert from "node:assert/strict";
import test from "node:test";
import { AgentCompletedOutputSchema, createSessionId, createToolCallId, createTraceId } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ActiveTurnSteeringState } from "../src/runtime/types.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import { createForegroundGuideControl, commitParentGuideYield } from "../src/runtime/methods/subagent-guide-yield.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { createAgentToolEntry } from "../src/tool/handlers/agent.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";

function owner() {
  const active = { turnId: `turn-${Math.random().toString(36).slice(2)}`, pendingInputs: [] } as unknown as ActiveTurnSteeringState;
  const runtime = { branchGeneration: 0 } as unknown as AgentRuntimeInternal;
  const control = createForegroundGuideControl(runtime, active);
  const add = (id: string) => active.pendingInputs.push({ id, delivery: "guide" } as never);
  return { runtime, active, control, add };
}

function state(control: ReturnType<typeof createForegroundGuideControl>, signal = new AbortController().signal) {
  return { parentForegroundControl: control, turnAbortSignal: signal } as RegularTurnLoopState;
}

function childControlOf(parent: ReturnType<typeof owner>, child: ReturnType<typeof owner>) {
  return createForegroundGuideControl(child.runtime, child.active, parent.control);
}

test("late child observes pending Guide; revocation and multiple sources read the input owner", () => {
  const parent = owner();
  parent.add("one");
  parent.add("two");
  const child = owner();
  const inherited = childControlOf(parent, child);
  assert.deepEqual(inherited.getYieldRequestIds?.(), ["one", "two"]);
  parent.active.pendingInputs.shift();
  assert.deepEqual(inherited.getYieldRequestIds?.(), ["two"]);
  parent.active.pendingInputs.length = 0;
  assert.equal(commitParentGuideYield(state(inherited)), false);
});

test("nested foreground joins inherit Guide, unrelated executions do not", () => {
  const parent = owner();
  const child = owner();
  const grandchild = owner();
  const nested = childControlOf(parent, child);
  const deep = createForegroundGuideControl(grandchild.runtime, child.active, nested);
  parent.add("guide");
  assert.equal(commitParentGuideYield(state(deep)), true);
  assert.equal(commitParentGuideYield(state(owner().control)), false);
});

test("branch replacement fences old controls; explicit abort wins", () => {
  const parent = owner();
  parent.add("guide");
  const abort = new AbortController();
  abort.abort();
  assert.equal(commitParentGuideYield(state(parent.control, abort.signal)), false);
  parent.runtime.branchGeneration++;
  assert.equal(commitParentGuideYield(state(parent.control)), false);
});

test("runner preserves yield identity and continuation starts without the old control", async () => {
  const parent = owner();
  parent.add("guide");
  let executions = 0;
  const events: unknown[] = [];
  const port = createExploreSubagentPort({
    runExploreAgent: async (child, options) => {
      executions++;
      if (executions === 1) {
        assert.equal(commitParentGuideYield(state(options!.foregroundExecution!)), true);
        return { response: "intermediate text", terminationReason: "parent_guide", traceId: child.traceContext.traceId, events: [] };
      }
      assert.equal(options?.foregroundExecution, undefined);
      return { response: "final result", traceId: child.traceContext.traceId, events: [] };
    },
    emitParentEvent: async (event) => { events.push(event); },
  });
  const request = {
    sessionId: createSessionId(), parentToolCallId: createToolCallId(), agentType: "general-purpose",
    description: "yield test", prompt: "work", workingDirectory: process.cwd(), workspaceRoot: process.cwd(),
    trace: { traceId: createTraceId() },
  };
  const first = await port.run(request, { foregroundExecution: parent.control });
  assert.equal(first.status, "completed");
  if (first.status !== "completed") throw new Error("expected completed");
  assert.equal(first.terminationReason, "parent_guide");
  assert.equal(first.content[0]?.text, "intermediate text");
  assert.equal(first.canContinue, true);
  assert.ok(first.childSessionId);
  assert.equal(AgentCompletedOutputSchema.safeParse(first).success, true);
  const formatted = createAgentToolEntry().formatModelContent!(first);
  assert.match(formatted, /Original task completion has not been confirmed/);
  assert.doesNotMatch(formatted, /intermediate text/);
  const relayFormatted = sendMessageToolEntry.formatModelContent!({ status: "success", messageId: "message", continuation: first });
  assert.match(relayFormatted, /childSessionId:/);
  assert.doesNotMatch(relayFormatted, /intermediate text/);
  parent.active.pendingInputs.length = 0;
  const continued = await port.sendMessage({ ...request, parentToolCallId: createToolCallId(), to: first.agentId, summary: "continue", message: "continue" });
  assert.equal(continued.continuation?.agentId, first.agentId);
  assert.equal(continued.continuation?.childSessionId, first.childSessionId);
  assert.equal(continued.continuation?.content[0]?.text, "final result");
  assert.equal(executions, 2);
  assert.ok(events.length > 0);
});
