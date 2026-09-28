import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionId,
  SessionInputRecord,
  SessionStorePort,
  TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ResolvedTurnAttachment } from "../src/runtime/types.js";
import { promoteOrphanedUserInput } from "../src/runtime/methods/promote-orphaned-user-input.js";
import { settleTurnEscapedSessionInput } from "../src/runtime/methods/turn-escape-settlement.js";

// 回合逃逸收口的行为契约（docs/specs/web-remote-command-recovery.md）：
// 1) 主路径已把正文放进内存历史、落库失败的逃逸：收口补投只写库，不再灌内存——
//    同一正文在 live 会话的模型上下文里只能有一份（时间线投影也只有一条）；
// 2) 逃逸发生在正文进内存之前（如附件解析阶段）：补投写库并水合内存；
// 3) 升格原语本身失败：退回结算 failed（turnLifecycleEscaped），不悬挂 admitted；
// 4) model-only / skipInputRecord 的内部注入不进用户转录，按旧规则直接结算。
//
// promoteOrphanedUserInput 挂真实实现：收口函数只做决策，升格语义由原语测试锁定。

const SESSION_ID = "session-escape" as SessionId;
const BASE_TIME = 1_700_000_000_000;
const TRACE: TraceContext = { traceId: "trace-escape-1" as TraceContext["traceId"] };

interface FakeRuntimeHandle {
  runtime: AgentRuntimeInternal;
  persistedPromptCount: number;
  settled: Array<{ id: string; status: string; reason?: string }>;
  historyEntryCount: number;
}

function fakeRuntime(options: {
  persistPromptThrows?: boolean;
}): FakeRuntimeHandle {
  const handle: FakeRuntimeHandle = {
    runtime: undefined as unknown as AgentRuntimeInternal,
    persistedPromptCount: 0,
    settled: [],
    historyEntryCount: 0,
  };
  const record: SessionInputRecord = {
    id: "queue-escape-1",
    sessionID: SESSION_ID,
    kind: "sendText",
    delivery: "queue",
    payload: {
      text: "逃逸的用户输入",
      intent: {
        sourceCommandId: "cmd-escape-1",
        queueItemId: "queue-escape-1",
        clientId: "cli",
        kind: "sendText",
        admissionSeq: 1,
        admittedAt: BASE_TIME,
        requestedDelivery: "startNow",
        admittedDelivery: "queue",
      },
    },
    admittedSequence: 1,
    status: "admitted",
    time: { created: BASE_TIME, updated: BASE_TIME },
  } as SessionInputRecord;
  const runtime = {
    sessionId: SESSION_ID,
    sessionStore: {
      getSessionInputById: async (id: string) => (id === record.id ? record : null),
      messages: async () => [],
      markSessionInputPromoted: async () => {},
      settleSessionInput: async (input: {
        id: string;
        status: SessionInputRecord["status"];
        reason?: string;
      }) => {
        handle.settled.push({ id: input.id, status: input.status, reason: input.reason });
      },
    } as unknown as SessionStorePort,
    persistUserPrompt: async () => {
      handle.persistedPromptCount += 1;
      if (options.persistPromptThrows) throw new Error("store unavailable");
      return {};
    },
    persistSyntheticUserNoticeForSession: async () => {},
    messageHistory: {
      addEntries: () => {
        handle.historyEntryCount += 1;
      },
      addUser: () => {},
    },
    logger: undefined,
    // 真实升格原语：收口决策 + 原语语义一起被验证。
    promoteOrphanedUserInput,
  } as unknown as AgentRuntimeInternal;
  handle.runtime = runtime;
  return handle;
}

const RESOLVED_ATTACHMENTS: ResolvedTurnAttachment[] = [];

test("落库失败后收口补投只写库，不得把正文再灌进内存历史", async () => {
  const handle = fakeRuntime({});
  // 主路径：正文已进内存历史（addEntries 成功），但落库失败、账本仍 admitted。
  handle.runtime.messageHistory.addEntries([]);
  assert.equal(handle.historyEntryCount, 1);

  await settleTurnEscapedSessionInput.call(handle.runtime, {
    sessionInputId: "queue-escape-1",
    text: "逃逸的用户输入",
    userPromptHydratedIntoHistory: true,
    resolvedAttachments: RESOLVED_ATTACHMENTS,
    turnId: "turn-1" as never,
    traceContext: TRACE,
  });

  // 库补上了（原语走了 persistUserPrompt），内存历史没有第二份。
  assert.equal(handle.persistedPromptCount, 1);
  assert.equal(handle.historyEntryCount, 1);
  assert.deepEqual(handle.settled, []);
});

test("逃逸发生在正文进内存之前：补投写库并水合内存历史", async () => {
  const handle = fakeRuntime({});

  await settleTurnEscapedSessionInput.call(handle.runtime, {
    sessionInputId: "queue-escape-1",
    text: "逃逸的用户输入",
    userPromptHydratedIntoHistory: false,
    turnId: "turn-1" as never,
    traceContext: TRACE,
  });

  assert.equal(handle.persistedPromptCount, 1);
  assert.equal(handle.historyEntryCount, 1);
  assert.deepEqual(handle.settled, []);
});

test("升格原语失败：退回结算 failed（turnLifecycleEscaped），不悬挂 admitted", async () => {
  const handle = fakeRuntime({ persistPromptThrows: true });

  await settleTurnEscapedSessionInput.call(handle.runtime, {
    sessionInputId: "queue-escape-1",
    text: "逃逸的用户输入",
    userPromptHydratedIntoHistory: false,
    turnId: "turn-1" as never,
    traceContext: TRACE,
  });

  assert.deepEqual(handle.settled, [
    { id: "queue-escape-1", status: "failed", reason: "fault.command.turnLifecycleEscaped" },
  ]);
});

test("model-only 内部注入：不补投，按旧规则直接结算 failed", async () => {
  const handle = fakeRuntime({});

  await settleTurnEscapedSessionInput.call(
    handle.runtime,
    {
      sessionInputId: "queue-escape-1",
      text: "内部注入",
      userPromptHydratedIntoHistory: false,
      turnId: "turn-1" as never,
      traceContext: TRACE,
    },
    { inputVisibility: "model-only" },
  );

  assert.equal(handle.persistedPromptCount, 0);
  assert.equal(handle.historyEntryCount, 0);
  assert.deepEqual(handle.settled, [
    { id: "queue-escape-1", status: "failed", reason: "fault.command.turnLifecycleEscaped" },
  ]);
});
