import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { isStaleBranchRuntimeTaskEvent } from "../src/runtime/methods/runtime-command-generation.js";

// SubagentProgress 与 SubagentStopped 走同一条 emitParentEvent 通道，
// 所以 stale-branch 过滤必须对两者一致：rewind 之后旧分支的子代理进度
// 不能继续往当前分支的会话里写数字。

type RuntimeStub = Parameters<typeof isStaleBranchRuntimeTaskEvent>[0];

function runtimeStub(options: {
  currentBranch: number;
  taskBranches: Record<string, number>;
}): RuntimeStub {
  return {
    branchGeneration: options.currentBranch,
    runtimeTaskRegistry: {
      get: (taskId: string) =>
        taskId in options.taskBranches
          ? { branchGeneration: options.taskBranches[taskId] }
          : undefined,
    },
  } as unknown as RuntimeStub;
}

let seq = 0;
function event(type: SessionEventType, payload: unknown): SessionEvent {
  seq += 1;
  return {
    id: `event-${seq}`,
    sessionId: "sess-stale-branch",
    turnId: "turn-1",
    type,
    timestamp: new Date(1_700_000_000_000),
    traceId: "trace-stale-branch",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

test("旧分支的 SubagentProgress 被丢弃，不写入当前分支会话", () => {
  const runtime = runtimeStub({ currentBranch: 2, taskBranches: { "agent-1": 1 } });

  const stale = isStaleBranchRuntimeTaskEvent(
    runtime,
    event(SessionEventType.SubagentProgress, {
      agentId: "agent-1",
      childSessionId: "sess-child-1",
      totalToolUseCount: 5,
      totalReasoningDurationMs: 8_000,
    }),
  );

  assert.equal(stale, true);
});

test("当前分支的 SubagentProgress 正常放行", () => {
  const runtime = runtimeStub({ currentBranch: 2, taskBranches: { "agent-1": 2 } });

  const fresh = isStaleBranchRuntimeTaskEvent(
    runtime,
    event(SessionEventType.SubagentProgress, {
      agentId: "agent-1",
      childSessionId: "sess-child-1",
      totalToolUseCount: 5,
      totalReasoningDurationMs: 8_000,
    }),
  );

  assert.equal(fresh, false);
});

test("进度与终态的 stale-branch 判定一致", () => {
  const runtime = runtimeStub({ currentBranch: 2, taskBranches: { "agent-1": 1 } });
  const payload = { agentId: "agent-1", childSessionId: "sess-child-1" };

  assert.equal(
    isStaleBranchRuntimeTaskEvent(runtime, event(SessionEventType.SubagentProgress, payload)),
    isStaleBranchRuntimeTaskEvent(runtime, event(SessionEventType.SubagentStopped, payload)),
  );
});
