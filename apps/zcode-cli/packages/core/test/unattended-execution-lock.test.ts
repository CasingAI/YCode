import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK, type SessionEntryInfo } from "@zcode/contracts";
import { applyRuntimeExecutionState } from "../src/runtime/execution-state.js";
import {
  ENTER_PLAN_MODE_UNATTENDED_LOCKED_ERROR_CODE,
  enterPlanModeToolEntry,
} from "../src/tool/handlers/plan-mode.js";
import {
  ensureUnattendedExecutionLock,
  hasAutomationAttribution,
  restoreUnattendedExecutionLockFromStore,
  unlockUnattendedExecutionForAcceptedInput,
  unlockUnattendedExecutionForHumanInput,
} from "../src/runtime/unattended-execution-lock.js";

// 这组用例守 docs/specs/automation-execution-mode.md 的无人值守锁：
// - 锁的唯一 owner 是 runtime，session entry 只是冷恢复快照；
// - 加锁/解锁都必须先写盘成功，再改内存；
// - 自动化归因永远优先于「已经解锁」；
// - 锁只拦截 source:"tool" 的切档，人工 command 切档放行但不清锁。

const SESSION_ID = "session-unattended-lock" as never;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface RuntimeHarness {
  runtime: never;
  state: { locked: boolean };
  calls: {
    saved: SessionEntryInfo[];
    events: unknown[];
  };
  failSave: boolean;
}

function createRuntime(
  options: {
    locked?: boolean;
    entries?: { data: unknown }[];
    sessionPersisted?: boolean;
    failSave?: boolean;
    mode?: string;
  } = {},
): RuntimeHarness {
  const calls: RuntimeHarness["calls"] = { saved: [], events: [] };
  const state = { locked: options.locked ?? false };
  const harness: RuntimeHarness = {
    runtime: undefined as never,
    state,
    calls,
    failSave: options.failSave ?? false,
  };
  const runtime = {
    sessionId: SESSION_ID,
    config: { mode: options.mode ?? "yolo" },
    sessionPersisted: options.sessionPersisted ?? true,
    permissionFullAccessPending: false,
    rootTraceContext: { queryId: "query-1" },
    unattendedHumanInputEpoch: 0,
    unattendedLockTransition: Promise.resolve() as Promise<void>,
    get unattendedExecutionLocked() {
      return state.locked;
    },
    set unattendedExecutionLocked(value: boolean) {
      state.locked = value;
    },
    sessionStore: {
      saveSessionEntry: async (entry: SessionEntryInfo) => {
        if (harness.failSave) throw new Error("disk full");
        calls.saved.push(entry);
      },
      sessionEntries: async (input: { type?: string }) => {
        if (input.type !== SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK) return [];
        return (options.entries ?? []) as SessionEntryInfo[];
      },
    },
    appendEvent: async (event: unknown) => {
      calls.events.push(event);
    },
    createEvent: (_type: unknown, data: unknown) => data,
  };
  harness.runtime = runtime as never;
  return harness;
}

test("带自动化归因的首次执行：先写 locked:true entry，再置内存锁", async () => {
  const { runtime, state, calls } = createRuntime();

  await ensureUnattendedExecutionLock(runtime, { automationId: "automation-1" });

  assert.equal(state.locked, true);
  assert.equal(calls.saved.length, 1);
  const entry = calls.saved[0]!;
  assert.equal(entry.type, SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK);
  assert.equal(entry.id, `${SESSION_ID}:runtime-unattended-execution-lock`);
  assert.deepEqual(entry.data, { locked: true });
  assert.equal(entry.touchSession, false);
});

test("没有自动化归因的普通 turn 不加锁，也不写盘", async () => {
  const { runtime, state, calls } = createRuntime();

  await ensureUnattendedExecutionLock(runtime, { inputId: "user-input-1" });

  assert.equal(state.locked, false);
  assert.deepEqual(calls.saved, []);
});

test("已锁定时幂等通过，不重复写盘", async () => {
  const { runtime, state, calls } = createRuntime({ locked: true });

  await ensureUnattendedExecutionLock(runtime, { offPeakTaskId: "offpeak-1" });

  assert.equal(state.locked, true);
  assert.deepEqual(calls.saved, []);
});

test("加锁写盘失败：拒绝执行且内存不得出现假锁", async () => {
  const { runtime, state } = createRuntime({ failSave: true });

  await assert.rejects(
    ensureUnattendedExecutionLock(runtime, { automationId: "automation-1" }),
    /unattended execution lock/i,
  );
  assert.equal(state.locked, false);
});

test("会话未持久化（没有可写 entry 的 store）时 fail closed", async () => {
  const { runtime, state } = createRuntime({ sessionPersisted: false });

  await assert.rejects(
    ensureUnattendedExecutionLock(runtime, { automationId: "automation-1" }),
    /unattended execution lock/i,
  );
  assert.equal(state.locked, false);
});

test("归因兜底：queryId 的 automation-/offpeak- 前缀同样算自动化", () => {
  assert.equal(hasAutomationAttribution({ queryId: "automation-abc:step-1" as never }), true);
  assert.equal(hasAutomationAttribution({ queryId: "offpeak-abc:resume-1" as never }), true);
  assert.equal(hasAutomationAttribution({ queryId: "user-query-1" as never }), false);
  assert.equal(hasAutomationAttribution({ automationId: "automation-1" }), true);
  assert.equal(hasAutomationAttribution({ offPeakTaskId: "offpeak-1" }), true);
});

test("归因兜底：仅有 inputId 的派发同样按前缀识别自动化", () => {
  assert.equal(hasAutomationAttribution({ inputId: "automation-abc:step-1" }), true);
  assert.equal(hasAutomationAttribution({ inputId: "offpeak-abc:init" }), true);
  assert.equal(hasAutomationAttribution({ inputId: "command-1" }), false);
  // 任一信号带自动化前缀都算归因，避免只带 inputId 的派发漏锁。
  assert.equal(hasAutomationAttribution({ queryId: "command-1", inputId: "automation-1" }), true);
});

test("只带 inputId 的自动化派发在首个模型请求前照样落锁", async () => {
  const { runtime, state } = createRuntime();

  await ensureUnattendedExecutionLock(runtime, { inputId: "automation-run-1" });

  assert.equal(state.locked, true);
});

test("人工新消息解锁：先写 locked:false，再清内存", async () => {
  const { runtime, state, calls } = createRuntime({ locked: true });

  await unlockUnattendedExecutionForHumanInput(runtime, {
    unlocksUnattendedModeSwitch: true,
  });

  assert.equal(state.locked, false);
  assert.equal(calls.saved.length, 1);
  assert.deepEqual(calls.saved[0]!.data, { locked: false });
});

test("没有人工新消息标记的输入不解锁（队列升格/重试/自主续跑）", async () => {
  const { runtime, state, calls } = createRuntime({ locked: true });

  await unlockUnattendedExecutionForHumanInput(runtime, { inputId: "queue-item-1" });

  assert.equal(state.locked, true);
  assert.deepEqual(calls.saved, []);
});

test("归因优先：即使调用方标了人工消息，带 automationId 也不解锁", async () => {
  const { runtime, state, calls } = createRuntime({ locked: true });

  await unlockUnattendedExecutionForHumanInput(runtime, {
    unlocksUnattendedModeSwitch: true,
    automationId: "automation-1",
  });

  assert.equal(state.locked, true);
  assert.deepEqual(calls.saved, []);
});

test("解锁写盘失败：保持内存锁并让输入失败", async () => {
  const { runtime, state } = createRuntime({ locked: true, failSave: true });

  await assert.rejects(
    unlockUnattendedExecutionForHumanInput(runtime, {
      unlocksUnattendedModeSwitch: true,
    }),
    /unattended execution lock/i,
  );
  assert.equal(state.locked, true);
});

test("未接纳的解锁失败不推进人工接纳计数", async () => {
  const { runtime } = createRuntime({ locked: true, failSave: true });
  const epoch = () =>
    (runtime as unknown as { unattendedHumanInputEpoch: number }).unattendedHumanInputEpoch;

  await assert.rejects(
    unlockUnattendedExecutionForHumanInput(runtime, { unlocksUnattendedModeSwitch: true }),
    /unattended execution lock/i,
  );
  assert.equal(epoch(), 0);
});

test("已接纳输入的解锁失败：吞掉错误、保持锁、计数照常推进", async () => {
  const { runtime, state, calls } = createRuntime({ locked: true, failSave: true });
  const epoch = () =>
    (runtime as unknown as { unattendedHumanInputEpoch: number }).unattendedHumanInputEpoch;

  await unlockUnattendedExecutionForAcceptedInput(runtime, {
    unlocksUnattendedModeSwitch: true,
  });

  assert.equal(state.locked, true);
  assert.equal(epoch(), 1);
  assert.deepEqual(calls.saved, []);
});

test("store 只有写能力没有读能力时加锁 fail closed，避免锁无法冷恢复", async () => {
  const { runtime, state, calls } = createRuntime();
  const store = (runtime as unknown as { sessionStore: Record<string, unknown> }).sessionStore;
  delete store.sessionEntries;

  await assert.rejects(
    ensureUnattendedExecutionLock(runtime, { automationId: "automation-1" }),
    /unattended execution lock/i,
  );

  assert.equal(state.locked, false);
  assert.deepEqual(calls.saved, []);
});

test("人工接纳基线已推进时，启动中的自动化 turn 不再上锁", async () => {
  const { runtime, state, calls } = createRuntime();
  (runtime as unknown as { unattendedHumanInputEpoch: number }).unattendedHumanInputEpoch = 1;

  await ensureUnattendedExecutionLock(runtime, { automationId: "automation-1" }, 0);

  assert.equal(state.locked, false);
  assert.deepEqual(calls.saved, []);
});

test("解锁与进行中的加锁串行：最终未锁，写入顺序 true→false", async () => {
  const { runtime, state, calls } = createRuntime();
  const writeGate = deferred();
  const store = (runtime as unknown as { sessionStore: Record<string, unknown> }).sessionStore;
  const save = store.saveSessionEntry as (entry: SessionEntryInfo) => Promise<void>;
  store.saveSessionEntry = async (entry: SessionEntryInfo) => {
    if ((entry.data as { locked?: boolean }).locked === true) await writeGate.promise;
    await save(entry);
  };

  const ensure = ensureUnattendedExecutionLock(runtime, { automationId: "automation-1" });
  const unlock = unlockUnattendedExecutionForHumanInput(runtime, {
    unlocksUnattendedModeSwitch: true,
  });
  // 先让加锁真正停在写盘上，再放行：解锁必须排队，不能看到旧的内存状态。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.locked, false);
  writeGate.resolve();
  await Promise.all([ensure, unlock]);

  assert.equal(state.locked, false);
  assert.deepEqual(
    calls.saved.map((entry) => entry.data),
    [{ locked: true }, { locked: false }],
  );
});

test("冷恢复：最后一条 entry 为 true 时恢复锁定，不自动解锁", async () => {
  const { runtime, state, calls } = createRuntime({
    entries: [{ data: { locked: false } }, { data: { locked: true } }],
  });

  await restoreUnattendedExecutionLockFromStore(runtime);

  assert.equal(state.locked, true);
  assert.deepEqual(calls.saved, []);
});

test("冷恢复：最后一条 entry 为 false 或没有 entry 时保持未锁定", async () => {
  const lockedRuntime = createRuntime({
    entries: [{ data: { locked: true } }, { data: { locked: false } }],
  });
  await restoreUnattendedExecutionLockFromStore(lockedRuntime.runtime);
  assert.equal(lockedRuntime.state.locked, false);

  const emptyRuntime = createRuntime();
  await restoreUnattendedExecutionLockFromStore(emptyRuntime.runtime);
  assert.equal(emptyRuntime.state.locked, false);
});

test("锁定期间 source:tool 的切档硬拒绝，且 mode/entry/event 全无副作用", async () => {
  const { runtime, calls } = createRuntime({ locked: true, mode: "yolo" });
  const typed = runtime as unknown as { config: { mode: string } };

  await assert.rejects(
    applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "tool", toolCallId: "tool-1" }),
    /unattended|automation/i,
  );

  assert.equal(typed.config.mode, "yolo");
  assert.deepEqual(calls.saved, []);
  assert.deepEqual(calls.events, []);
});

test("锁定期间 source:command 的人工切档放行，锁保持", async () => {
  const { runtime, state, calls } = createRuntime({ locked: true, mode: "yolo" });
  const typed = runtime as unknown as { config: { mode: string } };

  const next = await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });

  assert.equal(next.mode, "plan");
  assert.equal(typed.config.mode, "plan");
  assert.equal(state.locked, true);
  // command 切档只写既有 execution state entry，不触碰锁 entry。
  assert.deepEqual(
    calls.saved.filter((entry) => entry.type === SESSION_ENTRY_UNATTENDED_EXECUTION_LOCK),
    [],
  );
});

test("未锁定时 source:tool 的切档照常成功", async () => {
  const { runtime, state } = createRuntime({ locked: false, mode: "yolo" });

  const next = await applyRuntimeExecutionState(
    runtime,
    { mode: "plan" },
    { source: "tool", toolCallId: "tool-1" },
  );

  assert.equal(next.mode, "plan");
  assert.equal(state.locked, false);
});

test("解锁后模型工具可再次切档", async () => {
  const { runtime, state } = createRuntime({ locked: true, mode: "yolo" });
  await unlockUnattendedExecutionForHumanInput(runtime, {
    unlocksUnattendedModeSwitch: true,
  });

  const next = await applyRuntimeExecutionState(
    runtime,
    { mode: "plan" },
    { source: "tool", toolCallId: "tool-1" },
  );

  assert.equal(next.mode, "plan");
  assert.equal(state.locked, false);
});

test("EnterPlanMode 在锁定时返回可读失败，且不调用切档入口", async () => {
  let enterCalls = 0;
  const context = {
    sessionModePort: {
      getMode: () => "yolo",
      getModeSwitchRestriction: () => ({ reason: "Automation is running unattended." }),
      enterPlanMode: async () => {
        enterCalls += 1;
        return { mode: "plan", previousMode: "yolo" };
      },
    },
    toolCallId: "tool-1",
  } as never;

  const result = await enterPlanModeToolEntry.handler({}, context);

  assert.equal(enterCalls, 0);
  assert.equal((result as { result: boolean }).result, false);
  assert.equal(
    (result as { errorCode: number }).errorCode,
    ENTER_PLAN_MODE_UNATTENDED_LOCKED_ERROR_CODE,
  );
});

test("EnterPlanMode 未被锁时照常切档", async () => {
  let enterCalls = 0;
  const context = {
    sessionModePort: {
      getMode: () => "yolo",
      enterPlanMode: async () => {
        enterCalls += 1;
        return { mode: "plan", previousMode: "yolo" };
      },
    },
    toolCallId: "tool-1",
  } as never;

  const result = await enterPlanModeToolEntry.handler({}, context);

  assert.equal(enterCalls, 1);
  assert.equal((result as { mode: string }).mode, "plan");
});
