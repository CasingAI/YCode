import assert from "node:assert/strict";
import test from "node:test";
// handlers/index.js 必须先进来：goal-compact → session-flow → prompt-turn → session-residency
// 回到 handlers/index 构成既有循环，先导入 barrel 才能让 handler 表在被 spread 前完成初始化。
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";
import {
  applyGoalCommand,
  V4GoalCompactRejectedError,
} from "../src/zcode-protocol-v4/commands/handlers/goal-compact.js";

const sendGoalCommand = NATIVE_HANDLERS.sendGoalCommand;

// 受限档（Plan / Ask）与 Goal 互斥：Goal 的自主循环要落盘，这两档都跑不动。
// 过去 sendGoalCommand 会把载荷和 runtime 一起升到 yolo，等于让 Goal 命令
// 绕过模式轴自己切档。协议直连同样不得绕过，所以拒绝必须发生在写目标之前。

const SESSION_ID = "goal-mode-gate";

function buildRecord(mode: "plan" | "readonly" | "yolo") {
  const calls: string[] = [];
  const existingTarget = { status: "paused" as const };
  const record = {
    app: {
      sessionId: SESSION_ID,
      getMode: () => mode,
      getModel: () => "openai/gpt-5",
      readTarget: async () => existingTarget,
      setTarget: async () => {
        calls.push("setTarget");
      },
      updateTargetStatus: async () => null,
      continueActiveTarget: async () => {
        calls.push("continueActiveTarget");
      },
      runtime: {
        getSessionModelSelection: () => ({ providerId: "openai", modelId: "gpt-5" }),
        getPlanEnabled: () => mode === "plan",
        getReadOnlyEnabled: () => mode === "readonly",
        setExecutionState: async () => {
          calls.push("setExecutionState");
        },
        releaseForegroundPromotionLease: () => {},
      },
    },
    traceContext: { queryId: "query-1" },
    workspace: { workspacePath: "/tmp/workspace" },
    persistence: "immediate",
  } as unknown as V4SessionRecordView;
  return { record, calls };
}

function buildHost(record: V4SessionRecordView) {
  return {
    getRecord: (sessionId: string) => (sessionId === SESSION_ID ? record : undefined),
    ensureModelReady: async () => {},
  } as unknown as V4CommandCoreHost;
}

function envelope(payload: Record<string, unknown>) {
  return { commandId: "cmd-1", sessionId: SESSION_ID, payload } as never;
}

async function expectRejection(promise: Promise<unknown>, reasonCode: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof V4GoalCompactRejectedError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

test("Plan 下 sendGoalCommand 被拒：不写目标、不改档位", async () => {
  const { record, calls } = buildRecord("plan");
  await expectRejection(
    sendGoalCommand(buildHost(record), envelope({ text: "/goal 修复登录" })),
    "guard.planGoalMutuallyExclusive",
  );
  assert.deepEqual(calls, []);
});

test("Ask 下 sendGoalCommand 被拒：不写目标、不改档位", async () => {
  const { record, calls } = buildRecord("readonly");
  await expectRejection(
    sendGoalCommand(buildHost(record), envelope({ text: "/goal 修复登录" })),
    "guard.readOnlyGoalMutuallyExclusive",
  );
  assert.deepEqual(calls, []);
});

test("载荷声明的档位受限：即使会话当前是 Agent 也拒绝", async () => {
  const { record, calls } = buildRecord("yolo");
  await expectRejection(
    sendGoalCommand(
      buildHost(record),
      envelope({ text: "/goal 修复登录", mode: "plan" }),
    ),
    "guard.planGoalMutuallyExclusive",
  );
  assert.deepEqual(calls, []);
});

test("队列消费时用户已切到 Plan：按当时档位拒绝，不把 runtime 升回 Agent", async () => {
  const { record, calls } = buildRecord("plan");
  await expectRejection(
    applyGoalCommand(buildHost(record), record, {
      inputId: "cmd-1",
      objective: "修复登录",
      // 入队时冻结的 intent 仍是 Agent：不能只按它判定。
      intent: { kind: "sendGoalCommand", text: "修复登录", mode: "yolo" } as never,
    }),
    "guard.planGoalMutuallyExclusive",
  );
  assert.deepEqual(calls, []);
});

test("队列消费时用户已切到 Ask：按当时档位拒绝", async () => {
  const { record, calls } = buildRecord("readonly");
  await expectRejection(
    applyGoalCommand(buildHost(record), record, {
      inputId: "cmd-1",
      objective: "修复登录",
      intent: { kind: "sendGoalCommand", text: "修复登录", mode: "yolo" } as never,
    }),
    "guard.readOnlyGoalMutuallyExclusive",
  );
  assert.deepEqual(calls, []);
});

test("intent 自身声明受限档时同样拒绝，不靠会话当前档位兜底", async () => {
  const { record, calls } = buildRecord("yolo");
  await expectRejection(
    applyGoalCommand(buildHost(record), record, {
      inputId: "cmd-1",
      objective: "修复登录",
      intent: { kind: "sendGoalCommand", text: "修复登录", mode: "yolo", planEnabled: true } as never,
    }),
    "guard.planGoalMutuallyExclusive",
  );
  assert.deepEqual(calls, []);
});

test("Agent 下正常写目标并起续跑，门禁没有把正常路径一起拦掉", async () => {
  const { record, calls } = buildRecord("yolo");
  await applyGoalCommand(buildHost(record), record, {
    inputId: "cmd-1",
    objective: "修复登录",
    intent: { kind: "sendGoalCommand", text: "修复登录", mode: "yolo" } as never,
  });
  // 续跑在后台 detach，等一拍再断言它真的起来了。
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["setTarget", "continueActiveTarget"]);
});
