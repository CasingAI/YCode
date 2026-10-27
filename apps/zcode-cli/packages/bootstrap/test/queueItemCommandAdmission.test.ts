import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

// 队列项命令的准入判据（docs/specs/queue-item-command-admission.md）：
// 目标是「某个队列项」的命令不再要求整会话 revision 相等，改以目标项自身是否仍可
// 操作为准。Web / 手机 replayable 链路的投影推送间隔长于一次命令往返，客户端手里
// 的 baseRevision 天然落后，继续比较 revision 会把「删除一条仍在队列里的消息」误判
// 成 proto.staleRevision。

function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    commandId: "queue-command",
    clientId: "client-test",
    sessionId: "session-test",
    type: "deleteQueueItem",
    payload: { queueItemId: "queue_1" },
    baseRevision: 3,
    issuedAt: 1,
    ...overrides,
  } as CommandEnvelope;
}

test("会话 revision 已推进时，删除仍在队列里的消息仍被接受", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-1",
  });

  const outcome = await inbox.handle(envelope({ baseRevision: 3 }));
  assert.equal(outcome.kind, "execute");
  if (outcome.kind === "execute") outcome.settle({ status: "accepted" });
});

test("队列项命令的 revision 相等语义一律退出（编辑 / 排序 / 立即发送）", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-1",
  });

  const cases: ReadonlyArray<Pick<CommandEnvelope, "type" | "payload">> = [
    { type: "editQueueItem", payload: { queueItemId: "queue_1", newText: "改写" } },
    { type: "reorderQueueItem", payload: { queueItemId: "queue_1", beforeQueueItemId: null } },
    { type: "sendQueuedNow", payload: { queueItemId: "queue_1" } },
  ];
  for (const [index, item] of cases.entries()) {
    const outcome = await inbox.handle(
      envelope({
        commandId: `queue-command-${index}`,
        type: item.type,
        payload: item.payload,
        baseRevision: 3,
      }),
    );
    assert.equal(outcome.kind, "execute", `${item.type} 不应因 revision 推进被判 stale`);
    if (outcome.kind === "execute") outcome.settle({ status: "accepted" });
  }
});

test("队列项命令仍必须携带 baseRevision（审计用途不豁免信封校验）", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-1",
  });

  const outcome = await inbox.handle(envelope({ baseRevision: undefined }));
  assert.equal(outcome.kind, "ack");
  if (outcome.kind !== "ack") return;
  assert.equal(outcome.ack.status, "rejected");
  // 信封解析阶段就拦下（parseCommandEnvelope 对 CAS 命令强制 baseRevision），
  // 进不到 decide() 的 proto.missingBaseRevision 分支。
  assert.equal(outcome.ack.reasonCode, "proto.invalidPayload");
});

test("行目标命令的 revision 相等语义不变", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-1",
  });

  const outcome = await inbox.handle(
    envelope({
      type: "editUserQuery",
      payload: { target: { rowId: 1, entityId: "entity-1" }, newText: "rewrite" },
      baseRevision: 3,
      baseLogEpoch: "epoch-1",
    }),
  );
  assert.equal(outcome.kind, "ack");
  if (outcome.kind !== "ack") return;
  assert.equal(outcome.ack.status, "stale");
  assert.equal(outcome.ack.reasonCode, "proto.staleRevision");
});

// ── handler 层：目标队列项是否仍可操作 ──────────────────────────────

function queueItemFixture(
  dispatchState: "queued" | "reserved" | "promoting",
  admittedDelivery: "queue" | "guide" = "queue",
) {
  return {
    sourceCommandId: "cmd-1",
    queueItemId: "queue_1",
    clientId: "cli",
    kind: "sendText",
    text: "排队的消息",
    order: { admissionSeq: 1, queuePosition: 0 },
    admittedAt: 0,
    delivery: { requested: admittedDelivery, admitted: admittedDelivery },
    attachments: [],
    dispatch: { state: dispatchState },
    steer: { state: admittedDelivery === "guide" ? "steering" : "notRequested" },
  };
}

interface QueueHarness {
  host: V4CommandCoreHost;
  removed: string[];
}

function buildQueueHarness(options: {
  dispatchState: "queued" | "reserved" | "promoting";
  admittedDelivery?: "queue" | "guide";
  /** 投影里查不到该项（已消费 / 已删除）。 */
  missing?: boolean;
  /** runtime 侧移除失败（并发消费）。 */
  removeReturnsFalse?: boolean;
}): QueueHarness {
  const removed: string[] = [];
  const record = {
    app: {
      sessionId: "queue-session",
      removeQueueItem: async (queueItemId: string) => {
        if (options.removeReturnsFalse) return false;
        removed.push(queueItemId);
        return true;
      },
      editQueueItem: async () => true,
      reorderQueueItem: async () => true,
    },
    workspace: { workspacePath: "/tmp/workspace" },
  } as unknown as V4SessionRecordView;
  const host = {
    getRecord: (sessionId: string) => (sessionId === "queue-session" ? record : undefined),
    getQueueItem: (_sessionId: string, queueItemId: string) =>
      options.missing || queueItemId !== "queue_1"
        ? null
        : queueItemFixture(options.dispatchState, options.admittedDelivery),
  } as unknown as V4CommandCoreHost;
  return { host, removed };
}

test("删除目标队列项：仍在队列（queued）→ 真的删掉", async () => {
  const harness = buildQueueHarness({ dispatchState: "queued" });
  await NATIVE_HANDLERS.deleteQueueItem(harness.host, {
    commandId: "cmd-1",
    sessionId: "queue-session",
    payload: { queueItemId: "queue_1" },
  } as never);
  assert.deepEqual(harness.removed, ["queue_1"]);
});

test("删除目标队列项：已消费（投影里没有该项）→ noop，不算失败", async () => {
  const harness = buildQueueHarness({ dispatchState: "queued", missing: true });
  await assert.rejects(
    () =>
      NATIVE_HANDLERS.deleteQueueItem(harness.host, {
        commandId: "cmd-1",
        sessionId: "queue-session",
        payload: { queueItemId: "queue_1" },
      } as never),
    (error: unknown) => {
      assert.equal((error as { name: string }).name, "V4CommandNoopError");
      assert.equal((error as { reasonCode: string }).reasonCode, "queue.itemMissing");
      return true;
    },
  );
  assert.deepEqual(harness.removed, []);
});

test("删除目标队列项：正在派发（reserved / promoting）→ 拒绝，不删", async () => {
  for (const dispatchState of ["reserved", "promoting"] as const) {
    const harness = buildQueueHarness({ dispatchState });
    await assert.rejects(
      () =>
        NATIVE_HANDLERS.deleteQueueItem(harness.host, {
          commandId: "cmd-1",
          sessionId: "queue-session",
          payload: { queueItemId: "queue_1" },
        } as never),
      (error: unknown) => {
        assert.equal((error as { reasonCode: string }).reasonCode, "guard.queueItemReserved");
        return true;
      },
    );
    assert.deepEqual(harness.removed, []);
  }
});

test("删除目标队列项：runtime 侧竞态移除失败 → noop，不报成功", async () => {
  const harness = buildQueueHarness({ dispatchState: "queued", removeReturnsFalse: true });
  await assert.rejects(
    () =>
      NATIVE_HANDLERS.deleteQueueItem(harness.host, {
        commandId: "cmd-1",
        sessionId: "queue-session",
        payload: { queueItemId: "queue_1" },
      } as never),
    (error: unknown) => {
      assert.equal((error as { name: string }).name, "V4CommandNoopError");
      assert.equal((error as { reasonCode: string }).reasonCode, "queue.itemMissing");
      return true;
    },
  );
});

test("删除待引导 guide：admitted 且 queued → 与队列项同路径被允许", async () => {
  const harness = buildQueueHarness({ dispatchState: "queued", admittedDelivery: "guide" });
  await NATIVE_HANDLERS.deleteQueueItem(harness.host, {
    commandId: "cmd-guide",
    sessionId: "queue-session",
    payload: { queueItemId: "queue_1" },
  } as never);
  assert.deepEqual(harness.removed, ["queue_1"]);
});

test("删除待引导 guide：已 drain（投影无该项）→ noop，不回填", async () => {
  const harness = buildQueueHarness({
    dispatchState: "queued",
    admittedDelivery: "guide",
    missing: true,
  });
  await assert.rejects(
    () =>
      NATIVE_HANDLERS.deleteQueueItem(harness.host, {
        commandId: "cmd-guide-drained",
        sessionId: "queue-session",
        payload: { queueItemId: "queue_1" },
      } as never),
    (error: unknown) => {
      assert.equal((error as { name: string }).name, "V4CommandNoopError");
      assert.equal((error as { reasonCode: string }).reasonCode, "queue.itemMissing");
      return true;
    },
  );
  assert.deepEqual(harness.removed, []);
});

test("删除待引导 guide：reserved / promoting → 拒绝，不删", async () => {
  for (const dispatchState of ["reserved", "promoting"] as const) {
    const harness = buildQueueHarness({ dispatchState, admittedDelivery: "guide" });
    await assert.rejects(
      () =>
        NATIVE_HANDLERS.deleteQueueItem(harness.host, {
          commandId: `cmd-guide-${dispatchState}`,
          sessionId: "queue-session",
          payload: { queueItemId: "queue_1" },
        } as never),
      (error: unknown) => {
        assert.equal((error as { reasonCode: string }).reasonCode, "guard.queueItemReserved");
        return true;
      },
    );
    assert.deepEqual(harness.removed, []);
  }
});

test("编辑目标队列项：已消费 → noop（撤回编辑不得把旧投影恢复到 composer）", async () => {
  const harness = buildQueueHarness({ dispatchState: "queued", missing: true });
  await assert.rejects(
    () =>
      NATIVE_HANDLERS.editQueueItem(harness.host, {
        commandId: "cmd-1",
        sessionId: "queue-session",
        payload: { queueItemId: "queue_1", newText: "改写" },
      } as never),
    (error: unknown) => {
      assert.equal((error as { name: string }).name, "V4CommandNoopError");
      assert.equal((error as { reasonCode: string }).reasonCode, "queue.itemMissing");
      return true;
    },
  );
});

test("排序目标队列项：正在派发 → 拒绝", async () => {
  const harness = buildQueueHarness({ dispatchState: "reserved" });
  await assert.rejects(
    () =>
      NATIVE_HANDLERS.reorderQueueItem(harness.host, {
        commandId: "cmd-1",
        sessionId: "queue-session",
        payload: { queueItemId: "queue_1", beforeQueueItemId: null },
      } as never),
    (error: unknown) => {
      assert.equal((error as { reasonCode: string }).reasonCode, "guard.queueItemReserved");
      return true;
    },
  );
});
