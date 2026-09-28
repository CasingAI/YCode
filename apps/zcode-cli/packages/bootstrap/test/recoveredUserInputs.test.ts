import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageWithParts,
  SessionId,
  SessionInputRecord,
  SessionStorePort,
} from "@zcode/contracts";
import type { ZCodeApp } from "../src/app/types.js";
import { loadPersistentCommandFacts } from "../src/zcode-protocol-v4/persistent-command-facts.js";
import { lookupGlobalCreateSessionCommand } from "../src/zcode-protocol-v4/create-session-command-fact.js";
import { collectRecoverableUserInputs } from "../src/zcode-protocol/recovered-user-inputs.js";

// 补投让路的查询侧不变量：
// 1) 会话不 live 时，可补投的已受理行不在查询期结算（不进 discarded facts =
//    对账表现为 unknown、禁止重放），等冷恢复补投消费；
// 2) 主动排队与非用户发送的已受理行仍在查询期结算为重启丢弃，避免占住串行入口；
// 3) createSession 首条输入可补投时查询为未知（null）；
// 4) collectRecoverableUserInputs 的入选/排除与排序（历史幽灵行捞取）。

const SESSION_ID = "session-recovered" as SessionId;
const BASE_TIME = 1_700_000_000_000;

interface LedgerState {
  inputs: Map<string, SessionInputRecord>;
}

function inputRecord(options: {
  id: string;
  commandId?: string;
  kind?: string;
  status: SessionInputRecord["status"];
  statusReason?: string;
  text?: string;
  requestedDelivery?: string;
  created?: number;
  sourceCommandType?: string;
}): SessionInputRecord {
  // commandId 默认 `cmd-<行id>`；createSession 用例显式传入（行 id 是
  // `queueItemIdForCommand` 的 `queue_<commandId>`）。intent 同时落两个字段：
  // conversationInputIntent 是权威写入格式（嵌套 delivery），intent 是 runtime
  // metadata（扁平字段）——真实行两者并存，读侧对两条路径都要兼容。
  const sourceCommandId = options.commandId ?? `cmd-${options.id}`;
  const kind = options.kind ?? "sendText";
  const requestedDelivery = options.requestedDelivery ?? "startNow";
  return {
    id: options.id,
    sessionID: SESSION_ID,
    kind,
    delivery: "queue",
    payload: {
      text: options.text ?? "正文",
      conversationInputIntent: {
        sourceCommandId,
        queueItemId: options.id,
        clientId: "cli",
        kind,
        admissionSeq: 1,
        admittedAt: BASE_TIME,
        delivery: { requested: requestedDelivery, admitted: "queue" },
      },
      intent: {
        sourceCommandId,
        queueItemId: options.id,
        clientId: "cli",
        kind,
        admissionSeq: 1,
        admittedAt: BASE_TIME,
        requestedDelivery,
        admittedDelivery: "queue",
      },
      ...(options.sourceCommandType ? { sourceCommandType: options.sourceCommandType } : {}),
    },
    admittedSequence: 1,
    status: options.status,
    ...(options.statusReason ? { statusReason: options.statusReason } : {}),
    time: { created: options.created ?? BASE_TIME, updated: BASE_TIME },
  };
}

function fakeStore(state: LedgerState): SessionStorePort {
  return {
    messages: async () => [] as MessageWithParts[],
    listSessionInputs: async (input: { sessionID: SessionId; status?: string }) => {
      if (input.sessionID !== SESSION_ID) return [];
      return [...state.inputs.values()].filter(
        (record) => !input.status || record.status === input.status,
      );
    },
    getSessionInputById: async (id: string) => state.inputs.get(id) ?? null,
    settleSessionInput: async (input: {
      id: string;
      status: SessionInputRecord["status"];
      reason?: string;
    }) => {
      const record = state.inputs.get(input.id);
      if (!record || record.status !== "admitted") return;
      record.status = input.status;
      if (input.reason) record.statusReason = input.reason;
    },
  } as unknown as SessionStorePort;
}

test("查询期不结算可补投的已受理行；排队与非用户发送仍结算", async () => {
  const state: LedgerState = {
    inputs: new Map([
      ["queue_recoverable", inputRecord({ id: "queue_recoverable", status: "admitted", requestedDelivery: "startNow" })],
      ["queue_queued", inputRecord({ id: "queue_queued", status: "admitted", requestedDelivery: "queue" })],
      ["queue_compact", inputRecord({ id: "queue_compact", kind: "compact", status: "admitted" })],
    ]),
  };
  const store = fakeStore(state);

  const facts = await loadPersistentCommandFacts(store, SESSION_ID, {
    discardAdmittedOnLoad: true,
  });

  // 可补投行：不结算、不进 discarded facts —— 查询表现为 unknown（禁止重放）。
  assert.equal(state.inputs.get("queue_recoverable")?.status, "admitted");
  assert.equal(
    facts.discarded?.some((ack) => ack.commandId === "cmd-queue_recoverable"),
    false,
  );
  // 主动排队：仍结算为重启丢弃，事实下发失败（禁止重发）。
  assert.equal(state.inputs.get("queue_queued")?.status, "discarded");
  assert.equal(state.inputs.get("queue_queued")?.statusReason, "session_resumed");
  assert.equal(
    facts.discarded?.some(
      (ack) =>
        ack.commandId === "cmd-queue_queued" &&
        ack.status === "failed" &&
        ack.reasonCode === "fault.command.inputDiscardedOnRestart",
    ),
    true,
  );
  // 非用户发送（compact）：仍按重启清扫结算。
  assert.equal(state.inputs.get("queue_compact")?.status, "discarded");
});

test("createSession 首条输入可补投时查询为未知；排队仍结算为失败", async () => {
  const recoverableState: LedgerState = {
    inputs: new Map([
      [
        "queue_cmd-create-1",
        inputRecord({
          id: "queue_cmd-create-1",
          commandId: "cmd-create-1",
          status: "admitted",
          requestedDelivery: "startNow",
          sourceCommandType: "createSession",
        }),
      ],
    ]),
  };
  const recoverable = await lookupGlobalCreateSessionCommand(
    fakeStore(recoverableState),
    "cmd-create-1",
  );
  assert.equal(recoverable, null);
  assert.equal(recoverableState.inputs.get("queue_cmd-create-1")?.status, "admitted");

  const queuedState: LedgerState = {
    inputs: new Map([
      [
        "queue_cmd-create-2",
        inputRecord({
          id: "queue_cmd-create-2",
          commandId: "cmd-create-2",
          status: "admitted",
          requestedDelivery: "queue",
          sourceCommandType: "createSession",
        }),
      ],
    ]),
  };
  const queued = await lookupGlobalCreateSessionCommand(
    fakeStore(queuedState),
    "cmd-create-2",
  );
  assert.equal(queued?.status, "failed");
  assert.equal(queued?.reasonCode, "fault.command.inputDiscardedOnRestart");
  assert.equal(queuedState.inputs.get("queue_cmd-create-2")?.status, "discarded");

  const promotedState: LedgerState = {
    inputs: new Map([
      [
        "queue_cmd-create-3",
        inputRecord({
          id: "queue_cmd-create-3",
          commandId: "cmd-create-3",
          status: "promoted",
          requestedDelivery: "startNow",
          sourceCommandType: "createSession",
        }),
      ],
    ]),
  };
  const promoted = await lookupGlobalCreateSessionCommand(
    fakeStore(promotedState),
    "cmd-create-3",
  );
  assert.equal(promoted?.status, "accepted");
});

test("collectRecoverableUserInputs：入选/排除与按账本创建时间排序", async () => {
  const state: LedgerState = {
    inputs: new Map([
      // 入选：已受理非排队（时间最晚，验证排序）。
      ["admitted-1", inputRecord({ id: "admitted-1", status: "admitted", created: BASE_TIME + 3000 })],
      // 入选：历史丢弃（重启清扫）。
      ["discarded-1", inputRecord({ id: "discarded-1", status: "discarded", statusReason: "session_resumed", created: BASE_TIME + 1000 })],
      // 入选：回合逃逸失败。
      ["failed-escape", inputRecord({ id: "failed-escape", status: "failed", statusReason: "fault.command.turnLifecycleEscaped", created: BASE_TIME + 2000 })],
      // 入选：共享上下文挂不上的旧失败原因（新路径已不再写它，捞历史行）。
      ["failed-shared", inputRecord({ id: "failed-shared", status: "failed", statusReason: "shared_context_not_attachable", created: BASE_TIME + 1500 })],
      // 排除：主动排队。
      ["queued-1", inputRecord({ id: "queued-1", status: "admitted", requestedDelivery: "queue" })],
      // 排除：用户主动清空。
      ["cleared-1", inputRecord({ id: "cleared-1", status: "discarded", statusReason: "user_cleared" })],
      // 排除：用户删除（cancelled）。
      ["removed-1", inputRecord({ id: "removed-1", status: "cancelled" })],
      // 排除：其它 failed 原因（fork 启动失败）。
      ["failed-child", inputRecord({ id: "failed-child", status: "failed", statusReason: "fault.command.childStartFailed" })],
      // 排除：非用户发送种类。
      ["goal-1", inputRecord({ id: "goal-1", kind: "sendGoalCommand", status: "admitted" })],
      // 排除：无正文。
      ["empty-1", inputRecord({ id: "empty-1", status: "admitted", text: "" })],
      // 排除：解析不出命令号（内部注入行）。
      [
        "internal-1",
        {
          ...inputRecord({ id: "internal-1", status: "admitted" }),
          payload: { text: "内部注入" },
        },
      ],
    ]),
  };

  const app = {} as ZCodeApp;
  const collected = await collectRecoverableUserInputs(app, fakeStore(state), SESSION_ID);

  assert.deepEqual(
    collected.map((item) => item.sessionInputId),
    ["discarded-1", "failed-shared", "failed-escape", "admitted-1"],
  );
  // 时间戳取账创建时间：气泡按原发送位置落回。
  assert.equal(collected[0]?.createdAt, BASE_TIME + 1000);
  assert.equal(collected[2]?.text, "正文");
  // intent 从账本恢复，命令号随 intent 进入升格路径。
  assert.equal(collected[0]?.intent?.sourceCommandId, "cmd-discarded-1");
});
