import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionId,
  SessionInputRecord,
  SessionStorePort,
  TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { discardPersistedPendingSteerInputs } from "../src/runtime/methods/steering.js";

// 重启清扫的收窄不变量（docs/specs/web-remote-command-recovery.md「主动排队仍丢」）：
// 只有主动排队（requestedDelivery）与非用户发送种类在重启时结算为 discarded/session_resumed；
// 可补投的用户输入行（sendText + 非排队）必须留给冷恢复补投路径升格，不能在这里销毁。

const SESSION_ID = "session-sweep" as SessionId;
const TRACE: TraceContext = { traceId: "trace-sweep-1" as TraceContext["traceId"] };

function admittedRecord(options: {
  id: string;
  kind?: string;
  requestedDelivery?: string;
}): SessionInputRecord {
  return {
    id: options.id,
    sessionID: SESSION_ID,
    kind: options.kind ?? "sendText",
    delivery: "queue",
    payload: {
      text: "正文",
      ...(options.requestedDelivery
        ? {
            conversationInputIntent: {
              sourceCommandId: `cmd-${options.id}`,
              queueItemId: options.id,
              delivery: { requested: options.requestedDelivery, admitted: "queue" },
            },
          }
        : {}),
    },
    admittedSequence: 1,
    status: "admitted",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  } as SessionInputRecord;
}

test("重启清扫只销毁主动排队与非用户发送；可补投行与解析不出意图的行不销毁", async () => {
  const settled: Array<{ id: string; status: string; reason?: string }> = [];
  const store = {
    listSessionInputs: async (input: { sessionID: SessionId; status?: string }) => {
      if (input.sessionID !== SESSION_ID || input.status !== "admitted") return [];
      return [
        // 主动排队：清扫。
        admittedRecord({ id: "queued-1", requestedDelivery: "queue" }),
        // 非用户发送种类（compact 命令）：清扫。
        admittedRecord({ id: "compact-1", kind: "compact" }),
        // 可补投的用户输入（sendText + startNow）：留给补投路径。
        admittedRecord({ id: "recoverable-1", requestedDelivery: "startNow" }),
        // 解析不出投递意图：保守留给补投路径判断。
        admittedRecord({ id: "intent-less-1" }),
      ];
    },
    settleSessionInput: async (input: {
      id: string;
      status: SessionInputRecord["status"];
      reason?: string;
    }) => {
      settled.push({ id: input.id, status: input.status, reason: input.reason });
    },
  } as unknown as SessionStorePort;
  const runtime = {
    sessionId: SESSION_ID,
    sessionStore: store,
    logger: undefined,
    rebuildProjection: async () => ({ pendingSteerInputs: [] }),
  } as unknown as AgentRuntimeInternal;

  const discarded = await discardPersistedPendingSteerInputs.call(runtime, TRACE);

  assert.deepEqual(
    settled.map((entry) => entry.id).sort(),
    ["compact-1", "queued-1"],
  );
  assert.ok(settled.every((entry) => entry.status === "discarded" && entry.reason === "session_resumed"));
  // 投影里没有残留 pending steer：清扫函数对它们无事可做。
  assert.equal(discarded, 0);
});
