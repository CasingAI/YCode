import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGoal } from "@zcode/contracts";
import { applyRuntimeExecutionState } from "../src/runtime/execution-state.js";

// 这组用例守的是「Goal 是 active」和「用户要切模式」的冲突裁决。
// 裁决只有一种结果：把 Goal 收口为 paused，然后放行切换——包括 Goal 真在跑的情况。
//
// 「真在跑也放行」不是妥协，是有三条依据的：
// 1. status 才是 Goal 续跑的开关，turn 开头读它，非 active 就不带 Goal 续跑；
// 2. updateTargetStatus 不清 active run 租约，当前 turn 收尾时 finishTargetRun 照常记账；
// 3. 工具权限每次执行实时读 config.mode，切档立刻对在跑的 turn 收紧。
// 所以 turn 正常跑完、账不丢、权限已收紧，不存在需要拒绝用户的不一致。

const SESSION_ID = "session-goal-arbitration" as never;
const BASE_TIME = 1_700_000_000_000;

function buildGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: SESSION_ID,
    targetID: "target-1",
    objective: "把登录页修好",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: BASE_TIME, updated: BASE_TIME },
    ...overrides,
  };
}

interface RuntimeHarness {
  runtime: never;
  calls: {
    updateTargetStatus: { status: string }[];
    recorded: { previous: string; next: string }[];
    appendedEvents: unknown[];
  };
}

function createRuntime(options: { goal: SessionGoal | null; activeTurn: boolean }): RuntimeHarness {
  const calls: RuntimeHarness["calls"] = {
    updateTargetStatus: [],
    recorded: [],
    appendedEvents: [],
  };
  const goal = options.goal;
  const runtime = {
    sessionId: SESSION_ID,
    config: { mode: "yolo" },
    permissionFullAccessPending: false,
    // 落盘路径单独有测试覆盖；这里关掉，让用例只盯冲突裁决分支。
    sessionPersisted: false,
    rootTraceContext: { queryId: "query-1" },
    sessionStore: {
      updateTargetStatus: async (input: { status: string }) => {
        calls.updateTargetStatus.push({ status: input.status });
        return buildGoal({ status: input.status as SessionGoal["status"] });
      },
    },
    readSessionTargetForContext: async () => goal,
    getActiveTurnInfo: () => (options.activeTurn ? { turnId: "turn-1" } : null),
    recordTargetChanged: async (input: { previousTarget: SessionGoal; target: SessionGoal }) => {
      calls.recorded.push({
        previous: input.previousTarget.status,
        next: input.target.status,
      });
    },
    createEvent: (_type: unknown, data: unknown) => data,
    appendEvent: async (event: unknown) => {
      calls.appendedEvents.push(event);
    },
  };
  return { runtime: runtime as never, calls };
}

test("僵尸 goal：没有活跃 turn 时静默收口为 paused 并放行模式切换", async () => {
  const { runtime, calls } = createRuntime({ goal: buildGoal(), activeTurn: false });

  const next = await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });

  assert.equal(next.mode, "plan");
  assert.deepEqual(calls.updateTargetStatus, [{ status: "paused" }]);
  // 收口必须发布出去，否则 UI 仍会显示「运行中」。
  assert.deepEqual(calls.recorded, [{ previous: "active", next: "paused" }]);
});

test("僵尸 goal：只读档同样放行，不因为换了受限档就被拒绝", async () => {
  const { runtime, calls } = createRuntime({ goal: buildGoal(), activeTurn: false });

  const next = await applyRuntimeExecutionState(runtime, { mode: "readonly" }, { source: "command" });

  assert.equal(next.mode, "readonly");
  assert.deepEqual(calls.updateTargetStatus, [{ status: "paused" }]);
});

test("真有活跃 turn：一视同仁收口为 paused 并放行，不拒绝用户", async () => {
  const { runtime, calls } = createRuntime({ goal: buildGoal(), activeTurn: true });

  const next = await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });

  assert.equal(next.mode, "plan");
  assert.deepEqual(calls.updateTargetStatus, [{ status: "paused" }]);
  assert.deepEqual(calls.recorded, [{ previous: "active", next: "paused" }]);
});

test("真有活跃 turn：收口与模式事件都照常发出，turn 本身不被中断", async () => {
  const { runtime, calls } = createRuntime({ goal: buildGoal(), activeTurn: true });

  await applyRuntimeExecutionState(runtime, { mode: "readonly" }, { source: "command" });

  // 模式切换事件必须发出去，UI 才知道新档位生效；turn 继续跑自己的，不受影响。
  assert.equal(calls.appendedEvents.length, 1);
  assert.equal((calls.appendedEvents[0] as { mode: string }).mode, "readonly");
});

test("收口请求只写 status，不带任何会清掉 active run 租约的参数", async () => {
  const { runtime, calls } = createRuntime({ goal: buildGoal(), activeTurn: true });

  await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });

  // 多传一个清租约的字段就会让正在跑的 turn 丢掉 tokens/时长记账，这里钉死调用形状。
  assert.deepEqual(Object.keys(calls.updateTargetStatus[0]), ["status"]);
});

test("goal 已经 paused 时不触发任何收口，直接放行", async () => {
  const { runtime, calls } = createRuntime({
    goal: buildGoal({ status: "paused" }),
    activeTurn: false,
  });

  const next = await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });

  assert.equal(next.mode, "plan");
  assert.deepEqual(calls.updateTargetStatus, []);
  assert.deepEqual(calls.recorded, []);
});

test("从受限档退到非受限档不触发收口，Goal 原样保留", async () => {
  const { runtime, calls } = createRuntime({
    goal: buildGoal(),
    activeTurn: true,
  });
  // 起手就是 plan，说明已经在受限档；退出到 yolo 不该碰 goal。
  (runtime as unknown as { config: { mode: string } }).config.mode = "plan";

  const next = await applyRuntimeExecutionState(runtime, { mode: "yolo" }, { source: "command" });

  assert.equal(next.mode, "yolo");
  assert.deepEqual(calls.updateTargetStatus, []);
  assert.deepEqual(calls.recorded, []);
});

test("没有 goal 时不触发收口", async () => {
  const { runtime, calls } = createRuntime({ goal: null, activeTurn: false });

  const next = await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });

  assert.equal(next.mode, "plan");
  assert.deepEqual(calls.updateTargetStatus, []);
});
