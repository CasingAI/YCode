import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageWithParts,
  SessionId,
  SessionInputRecord,
  TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ResolvedTurnAttachment } from "../src/runtime/types.js";
import {
  buildSharedContextNoticeText,
  promoteOrphanedUserInput,
} from "../src/runtime/methods/promote-orphaned-user-input.js";

// 补投升格原语的核心契约：
// 1) 账本已 promoted → 空操作（成功路径重复触发不写双气泡）；
// 2) 转录已有同命令号 user 消息 → 只补账本，不写新消息；
// 3) 时间戳取账本 time.created，气泡/模型历史落回原发送位置；
// 4) 附件现场解析后丢弃失败占位（附件找不到就只留字）；resolvedAttachments 原样透传；
// 5) 共享上下文挂不上：正文照常升格 + 仅模型可见说明；内存历史先正文后说明。

const SESSION_ID = "session-orphan" as SessionId;
const BASE_TIME = 1_700_000_000_000;
const TRACE: TraceContext = { traceId: "trace-orphan-1" as TraceContext["traceId"] };

interface PersistedPromptCall {
  messageId: string;
  text: string;
  attachments: ResolvedTurnAttachment[] | undefined;
  options: Record<string, unknown> | undefined;
}

interface FakeRuntimeHandle {
  runtime: AgentRuntimeInternal;
  persistedPrompts: PersistedPromptCall[];
  syntheticNotices: Array<Record<string, unknown>>;
  historyCalls: Array<{ kind: "entries" | "user"; text?: string; metadata?: unknown }>;
  promotedLedger: Array<{ id: string; promotedMessageID: string }>;
}

function ledgerRecord(options: {
  id?: string;
  status?: SessionInputRecord["status"];
  text?: string;
  withCommandId?: boolean;
}): SessionInputRecord {
  const id = options.id ?? "queue_orphan-1";
  return {
    id,
    sessionID: SESSION_ID,
    kind: "sendText",
    delivery: "queue",
    payload: {
      text: options.text ?? "被丢弃的用户输入",
      ...(options.withCommandId === false
        ? {}
        : {
            intent: {
              sourceCommandId: "cmd-orphan-1",
              queueItemId: id,
              clientId: "cli",
              kind: "sendText",
              admissionSeq: 1,
              admittedAt: BASE_TIME,
              requestedDelivery: "startNow",
              admittedDelivery: "queue",
            },
          }),
    },
    admittedSequence: 1,
    status: options.status ?? "discarded",
    ...(options.status === "discarded" ? { statusReason: "session_resumed" } : {}),
    time: { created: BASE_TIME, updated: BASE_TIME },
  } as SessionInputRecord;
}

function fakeRuntime(options: {
  record?: SessionInputRecord | null;
  messages?: MessageWithParts[];
  persistOutcome?: { skippedSharedContextIds?: string[] };
}): FakeRuntimeHandle {
  const persistedPrompts: PersistedPromptCall[] = [];
  const syntheticNotices: Array<Record<string, unknown>> = [];
  const historyCalls: FakeRuntimeHandle["historyCalls"] = [];
  const promotedLedger: FakeRuntimeHandle["promotedLedger"] = [];
  const runtime = {
    sessionId: SESSION_ID,
    sessionStore: {
      getSessionInputById: async (id: string) =>
        options.record && id === options.record.id ? options.record : null,
      messages: async () => options.messages ?? [],
      markSessionInputPromoted: async (input: { id: string; promotedMessageID: string }) => {
        promotedLedger.push(input);
      },
    },
    persistUserPrompt: async (
      messageId: string,
      text: string,
      attachments: ResolvedTurnAttachment[] | undefined,
      _traceContext: TraceContext,
      persistOptions?: Record<string, unknown>,
    ) => {
      persistedPrompts.push({ messageId, text, attachments, options: persistOptions });
      return options.persistOutcome ?? {};
    },
    persistSyntheticUserNoticeForSession: async (notice: Record<string, unknown>) => {
      syntheticNotices.push(notice);
    },
    messageHistory: {
      addEntries: () => {
        historyCalls.push({ kind: "entries" });
      },
      addUser: (text: string, metadata: unknown) => {
        historyCalls.push({ kind: "user", text, metadata });
      },
    },
    logger: undefined,
  } as unknown as AgentRuntimeInternal;
  return { runtime, persistedPrompts, syntheticNotices, historyCalls, promotedLedger };
}

test("账本已 promoted：空操作，不写消息不补账本", async () => {
  const handle = fakeRuntime({ record: ledgerRecord({ status: "promoted" }) });

  const result = await promoteOrphanedUserInput.call(handle.runtime, {
    sessionInputId: "queue_orphan-1",
    traceContext: TRACE,
  });

  assert.equal(result.status, "already-promoted");
  assert.deepEqual(handle.persistedPrompts, []);
  assert.deepEqual(handle.promotedLedger, []);
});

test("转录已有同命令号 user 消息：跳过写消息，只把账本补成 promoted", async () => {
  const handle = fakeRuntime({
    record: ledgerRecord({ status: "discarded" }),
    messages: [
      {
        info: {
          id: "msg-existing-1",
          role: "user",
          anchor: { sourceCommandId: "cmd-orphan-1" },
        },
        parts: [],
      } as unknown as MessageWithParts,
    ],
  });

  const result = await promoteOrphanedUserInput.call(handle.runtime, {
    sessionInputId: "queue_orphan-1",
    traceContext: TRACE,
  });

  assert.equal(result.status, "duplicate");
  assert.equal(result.messageId, "msg-existing-1");
  // 只补账本状态，不产生第二条用户消息。
  assert.deepEqual(handle.persistedPrompts, []);
  assert.deepEqual(handle.promotedLedger, [
    { id: "queue_orphan-1", sessionID: SESSION_ID, promotedMessageID: "msg-existing-1" },
  ]);
});

test("正常升格：createdAt 用账本创建时间，正文与账本身份随事务写入", async () => {
  const handle = fakeRuntime({ record: ledgerRecord({ status: "discarded" }) });

  const result = await promoteOrphanedUserInput.call(handle.runtime, {
    sessionInputId: "queue_orphan-1",
    traceContext: TRACE,
  });

  assert.equal(result.status, "promoted");
  assert.equal(handle.persistedPrompts.length, 1);
  const call = handle.persistedPrompts[0]!;
  assert.equal(call.text, "被丢弃的用户输入");
  assert.equal(call.options?.createdAt, BASE_TIME);
  assert.equal(call.options?.sessionInputId, "queue_orphan-1");
  assert.equal(call.options?.sourceCommandId, "cmd-orphan-1");
  // 缺省不水合内存历史（冷恢复路径水合前由重读完成）。
  assert.deepEqual(handle.historyCalls, []);
});

test("解析不出命令号的行不是可补投用户输入：返回 missing", async () => {
  const handle = fakeRuntime({
    record: ledgerRecord({ status: "discarded", withCommandId: false }),
  });

  const result = await promoteOrphanedUserInput.call(handle.runtime, {
    sessionInputId: "queue_orphan-1",
    traceContext: TRACE,
  });

  assert.equal(result.status, "missing");
  assert.deepEqual(handle.persistedPrompts, []);
});

test("附件现场解析：失败占位被丢弃，成功附件保留", async () => {
  const handle = fakeRuntime({ record: ledgerRecord({ status: "discarded" }) });

  const result = await promoteOrphanedUserInput.call(handle.runtime, {
    sessionInputId: "queue_orphan-1",
    // url 附件不需要任何 port 即可解析成功；pdf 非法正文走 attachment_pdf_invalid 占位。
    attachments: [
      { type: "url", content: "https://example.com/report" },
      { type: "pdf", content: "%PDF-不是 data url", path: "broken.pdf" },
    ] as never,
    traceContext: TRACE,
  });

  assert.equal(result.status, "promoted");
  const attachments = handle.persistedPrompts[0]?.attachments;
  assert.equal(attachments?.length, 1);
  assert.equal(attachments?.[0]?.url, "https://example.com/report");
});

test("resolvedAttachments 原样透传（回合逃逸复用本回合已解析附件）", async () => {
  const handle = fakeRuntime({ record: ledgerRecord({ status: "discarded" }) });
  const resolved: ResolvedTurnAttachment[] = [
    {
      contentBlock: { type: "resource_link", uri: "https://example.com/report" },
      metadata: { originalUrl: "https://example.com/report" },
      mime: "text/uri-list",
      url: "https://example.com/report",
    } as ResolvedTurnAttachment,
  ];

  const result = await promoteOrphanedUserInput.call(handle.runtime, {
    sessionInputId: "queue_orphan-1",
    resolvedAttachments: resolved,
    traceContext: TRACE,
  });

  assert.equal(result.status, "promoted");
  assert.equal(handle.persistedPrompts[0]?.attachments, resolved);
});

test("共享上下文挂不上：正文照常升格，仅模型可见说明随后；内存历史先正文后说明", async () => {
  const handle = fakeRuntime({
    record: ledgerRecord({ status: "discarded" }),
    persistOutcome: { skippedSharedContextIds: ["ctx-gone-1"] },
  });

  const result = await promoteOrphanedUserInput.call(handle.runtime, {
    sessionInputId: "queue_orphan-1",
    hydrateIntoHistory: true,
    traceContext: TRACE,
  });

  assert.equal(result.status, "promoted");
  assert.deepEqual(result.skippedSharedContextIds, ["ctx-gone-1"]);
  // 正文已写入，不是回滚。
  assert.equal(handle.persistedPrompts[0]?.text, "被丢弃的用户输入");
  // 说明走 model-only 合成消息持久化（界面不画气泡）。
  assert.equal(handle.syntheticNotices.length, 1);
  assert.equal(handle.syntheticNotices[0]?.source, "shared_context");
  assert.equal(handle.syntheticNotices[0]?.visibility, "model-only");
  assert.ok(String(handle.syntheticNotices[0]?.text).includes("ctx-gone-1"));
  // 内存顺序与持久顺序一致：先正文、后说明。
  assert.deepEqual(handle.historyCalls.map((call) => call.kind), ["entries", "user"]);
  assert.equal(handle.historyCalls[1]?.text, buildSharedContextNoticeText(["ctx-gone-1"]));
});

test("buildSharedContextNoticeText：点名 contextId，禁止编造内容", () => {
  const text = buildSharedContextNoticeText(["ctx-a", "ctx-b"]);
  assert.ok(text.includes("ctx-a, ctx-b"));
  assert.ok(text.includes("Do not fabricate its content."));
});
