import assert from "node:assert/strict";
import test from "node:test";
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  type SessionEvent,
  type TurnCompletePayload,
} from "@zcode/contracts";
// handlers/index.js 必须先进来：goal-compact → session-flow → prompt-turn 的既有循环
// 依赖 barrel 先完成 handler 表初始化（与 commandModelBindingCompact.test.ts 同款约束）。
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import { startManualCompact } from "../src/zcode-protocol-v4/commands/handlers/goal-compact.js";
import type { SubmitPromptOptions } from "../src/app/types.js";

// docs/specs/stop-success-terminal-arbitration.md 规则 6：
// 手动 compact 的 Bootstrap 收口必须消费 Core 的终态事实与队列授权：
// - Core 因内部抢占取消（preserveQueueAutoDrainOnCancel=true）时，Bootstrap 父
//   controller 不会被 abort，不能因此误记 failed，也不能再次 hold 队列；
// - 用户 stop（无 preserve）仍按原规则 hold；
// - 真 compact 失败 hold；成功不改。
// 事件/错误都走 Core 公开契约，不复制 stopActiveForegroundExecution 的停止状态。

const SESSION_ID = "compact-terminal-arbitration";
const INPUT_ID = "cmd-compact-1";

interface CapturedFact {
  sessionId: string;
  kind: string;
  fact: { commandId: string; status: string };
  options?: { lifecycleStatus?: string };
}

interface Harness {
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  autoDrainCalls: boolean[];
  mutationReasons: string[];
  facts: CapturedFact[];
  releasedLeases: string[];
  finished: Promise<void>;
}

function turnCompleteEvent(
  inputId: string,
  resultType: "success" | "cancelled",
  preserveQueueAutoDrainOnCancel?: boolean,
): SessionEvent {
  const payload: TurnCompletePayload = {
    response: resultType === "success" ? "压缩完成" : "",
    tokenCount: 0,
    toolCallCount: 0,
    duration: 1,
    resultType,
    inputId,
    ...(preserveQueueAutoDrainOnCancel === undefined ? {} : { preserveQueueAutoDrainOnCancel }),
  };
  return {
    id: "event-turn-complete",
    sessionId: SESSION_ID,
    turnId: "turn-compact",
    type: SessionEventType.TurnComplete,
    timestamp: new Date(0),
    traceId: "trace-compact",
    sequenceNumber: 1,
    payload,
  } as SessionEvent;
}

function buildHarness(options: {
  submit: (options: SubmitPromptOptions) => Promise<void>;
  queueLength?: number;
}): Harness {
  const autoDrainCalls: boolean[] = [];
  const mutationReasons: string[] = [];
  const facts: CapturedFact[] = [];
  const releasedLeases: string[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const record = {
    app: {
      sessionId: SESSION_ID,
      submitPrompt: (text: string, submitOptions: SubmitPromptOptions) => {
        assert.equal(text, "/compact");
        assert.equal(submitOptions.inputId, INPUT_ID);
        return options.submit(submitOptions);
      },
      setQueueAutoDrain: async (autoDrain: boolean) => {
        autoDrainCalls.push(autoDrain);
      },
      runtime: {
        getActiveTurnInfo: () => undefined,
        releaseForegroundPromotionLease: (leaseId: string) => {
          releasedLeases.push(leaseId);
        },
      },
    },
    workspace: { workspacePath: "/tmp/workspace" },
    traceContext: { queryId: "query-compact" },
    persistence: "immediate",
  } as unknown as V4SessionRecordView;

  const host = {
    getRecord: (sessionId: string) => (sessionId === SESSION_ID ? record : undefined),
    getQueueLength: (sessionId: string) =>
      sessionId === SESSION_ID ? (options.queueLength ?? 0) : 0,
    ensureModelReady: async () => {},
    recordPersistentCommandFact: async (
      sessionId: string,
      kind: string,
      fact: CapturedFact["fact"],
      factOptions?: CapturedFact["options"],
    ) => {
      facts.push({ sessionId, kind, fact, options: factOptions });
    },
    afterLegacyStateMutation: async (_record: V4SessionRecordView, reason: string) => {
      mutationReasons.push(reason);
      resolveFinished();
    },
  } as unknown as V4CommandCoreHost;

  return {
    host,
    record,
    autoDrainCalls,
    mutationReasons,
    facts,
    releasedLeases,
    finished,
  };
}

async function runCompact(harness: Harness): Promise<void> {
  await startManualCompact(
    harness.host,
    harness.record,
    INPUT_ID,
    "lease-compact",
    undefined,
    "/compact",
  );
  await harness.finished;
}

test("Core 内部抢占取消 compact（父 signal 未 abort + preserve）→ cancelled，不 hold，lifecycle cancelled", async () => {
  let parentSignal: AbortSignal | undefined;
  const harness = buildHarness({
    queueLength: 2,
    submit: async (options) => {
      parentSignal = options.abortSignal;
      // Core 的真实顺序：停止只 abort foreground controller，父 controller 不受影响；
      // 终态事件携带 preserve，错误才是 TurnCancelled。
      await options.onEvent?.(turnCompleteEvent(INPUT_ID, "cancelled", true));
      throw createCoreError(CoreErrorType.TurnCancelled, "Turn was cancelled.");
    },
  });

  await runCompact(harness);

  assert.equal(
    parentSignal?.aborted,
    false,
    "Bootstrap 父 signal 未被 abort 也必须按 Core 终态判 cancelled",
  );
  assert.deepEqual(harness.autoDrainCalls, [], "preserve=true 时不得二次 hold 队列");
  assert.deepEqual(harness.mutationReasons, ["session_compact_cancelled"]);
  assert.equal(harness.facts.length, 1, "同一条 command 只写一次幂等 fact");
  assert.equal(harness.facts[0]?.fact.commandId, INPUT_ID);
  assert.equal(harness.facts[0]?.options?.lifecycleStatus, "cancelled");
  assert.deepEqual(harness.releasedLeases, ["lease-compact"], "promotion lease 必须释放");
  assert.equal(harness.record.activeAbortController, undefined, "compact owner 必须释放");
});

test("用户 stop 取消 compact（无 preserve）→ cancelled 且 hold 队列", async () => {
  let harness!: Harness;
  let parentController: AbortController | undefined;
  harness = buildHarness({
    queueLength: 1,
    submit: async (options) => {
      parentController = harness.record.activeAbortController;
      await options.onEvent?.(turnCompleteEvent(INPUT_ID, "cancelled"));
      // stop 路径由 Bootstrap 自己 abort 父 controller。
      harness.record.activeAbortController?.abort(new Error("v4 session stopped"));
      throw createCoreError(CoreErrorType.TurnCancelled, "Turn was cancelled.");
    },
  });

  await runCompact(harness);

  assert.equal(parentController?.signal.aborted, true);
  assert.deepEqual(harness.autoDrainCalls, [false], "用户 stop 必须 hold 队列");
  assert.deepEqual(harness.mutationReasons, ["session_compact_cancelled"]);
  assert.equal(harness.facts[0]?.options?.lifecycleStatus, "cancelled");
});

test("真 compact 失败（无终态事件、非取消错误）→ failed 且 hold 队列", async () => {
  const harness = buildHarness({
    queueLength: 1,
    submit: async () => {
      throw new Error("provider exploded");
    },
  });

  await runCompact(harness);

  assert.deepEqual(harness.autoDrainCalls, [false], "真失败必须 hold 队列");
  assert.deepEqual(harness.mutationReasons, ["session_compact_failed"]);
  assert.equal(harness.facts[0]?.options?.lifecycleStatus, "failed");
});

test("compact 成功不改：success，不 hold，lifecycle success", async () => {
  const harness = buildHarness({
    queueLength: 1,
    submit: async (options) => {
      await options.onEvent?.(turnCompleteEvent(INPUT_ID, "success"));
    },
  });

  await runCompact(harness);

  assert.deepEqual(harness.autoDrainCalls, [], "成功终态不得 hold 队列");
  assert.deepEqual(harness.mutationReasons, ["session_compacted"]);
  assert.equal(harness.facts[0]?.options?.lifecycleStatus, "success");
});

test("成功终态已提交后晚到 TurnCancelled → 仍按成功收口，不改写终态", async () => {
  const harness = buildHarness({
    queueLength: 1,
    submit: async (options) => {
      await options.onEvent?.(turnCompleteEvent(INPUT_ID, "success"));
      throw createCoreError(CoreErrorType.TurnCancelled, "late abort after commit");
    },
  });

  await runCompact(harness);

  assert.deepEqual(harness.autoDrainCalls, []);
  assert.deepEqual(harness.mutationReasons, ["session_compacted"]);
  assert.equal(harness.facts[0]?.options?.lifecycleStatus, "success");
});
