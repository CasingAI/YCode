import assert from "node:assert/strict";
import test from "node:test";
import type { TraceContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { promoteRecoveredUserInputsBeforeHydration } from "../src/runtime/methods/resume.js";
import type { PromoteOrphanedUserInputOptions } from "../src/runtime/methods/promote-orphaned-user-input.js";

// 冷恢复补投批处理的契约（docs/specs/web-remote-command-recovery.md）：
// 1) 列表为空时不动转录；
// 2) promoted 与 duplicate 计入收口数（duplicate 也是「账本已对齐」），missing 不计；
// 3) 单条失败只 warn 不中断，后续条目继续；
// 4) 调用参数完整透传给升格原语（text/createdAt/intent/attachments）。

const TRACE: TraceContext = { traceId: "trace-resume-1" as TraceContext["traceId"] };

interface PromotionCall {
  sessionInputId: string;
  text?: string;
  createdAt?: number;
  intent?: unknown;
  attachments?: unknown;
}

function fakeRuntime(options: {
  outcomes: Array<{ status: string } | Error>;
}): { runtime: AgentRuntimeInternal; calls: PromotionCall[] } {
  const calls: PromotionCall[] = [];
  const runtime = {
    promoteOrphanedUserInput: async (input: PromoteOrphanedUserInputOptions) => {
      const index = calls.length;
      calls.push({
        sessionInputId: input.sessionInputId,
        text: input.text,
        createdAt: input.createdAt,
        intent: input.intent,
        attachments: input.attachments,
      });
      const outcome = options.outcomes[index];
      if (outcome instanceof Error) throw outcome;
      return { status: outcome.status } as never;
    },
    logger: undefined,
  } as unknown as AgentRuntimeInternal;
  return { runtime, calls };
}

test("列表为空：不调原语，返回 0", async () => {
  const { runtime, calls } = fakeRuntime({ outcomes: [] });

  const count = await promoteRecoveredUserInputsBeforeHydration.call(runtime, {
    recoveredUserInputs: [],
    traceContext: TRACE,
  });
  const countUndefined = await promoteRecoveredUserInputsBeforeHydration.call(runtime, {
    recoveredUserInputs: undefined,
    traceContext: TRACE,
  });

  assert.equal(count, 0);
  assert.equal(countUndefined, 0);
  assert.deepEqual(calls, []);
});

test("promoted 与 duplicate 计入收口数；单条失败不拖死后续条目", async () => {
  const { runtime, calls } = fakeRuntime({
    outcomes: [
      { status: "promoted" },
      new Error("store 临时不可用"),
      { status: "duplicate" },
      { status: "missing" },
    ],
  });

  const count = await promoteRecoveredUserInputsBeforeHydration.call(runtime, {
    recoveredUserInputs: [
      { sessionInputId: "queue-1", text: "第一条", createdAt: 1000 },
      { sessionInputId: "queue-2", text: "第二条", createdAt: 2000 },
      { sessionInputId: "queue-3", text: "第三条", createdAt: 3000 },
      { sessionInputId: "queue-4", text: "第四条", createdAt: 4000 },
    ],
    traceContext: TRACE,
  });

  // 失败与 missing 不计，但不中断：四条都被尝试。
  assert.equal(count, 2);
  assert.deepEqual(
    calls.map((call) => call.sessionInputId),
    ["queue-1", "queue-2", "queue-3", "queue-4"],
  );
});

test("调用参数完整透传给升格原语", async () => {
  const { runtime, calls } = fakeRuntime({ outcomes: [{ status: "promoted" }] });
  const intent = {
    sourceCommandId: "cmd-1",
    queueItemId: "queue-1",
    clientId: "cli",
    kind: "sendText",
    admissionSeq: 1,
    admittedAt: 1000,
    requestedDelivery: "startNow",
    admittedDelivery: "queue",
  };

  await promoteRecoveredUserInputsBeforeHydration.call(runtime, {
    recoveredUserInputs: [
      {
        sessionInputId: "queue-1",
        text: "带附件的补投",
        createdAt: 1234,
        intent,
        attachments: [{ type: "url", content: "https://example.com/a" }] as never,
      },
    ],
    traceContext: TRACE,
  });

  assert.equal(calls[0]?.text, "带附件的补投");
  assert.equal(calls[0]?.createdAt, 1234);
  assert.equal(calls[0]?.intent, intent);
  assert.deepEqual(calls[0]?.attachments, [{ type: "url", content: "https://example.com/a" }]);
});
