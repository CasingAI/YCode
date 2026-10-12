import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

const SESSION_ID = "session-sandbox-projection";

// 沙盒实例存在性直推（docs/specs/sandbox-projection-push.md）：
// CLI 在实例变化时直接 commit state.updated { sandbox }，不走 SessionEvent 流，
// 订阅者在下一帧看到 alive 翻转，不再等 sandboxStatus 轮询节拍。
// 三态：alive=true（已确认活着）/ false（已确认死亡）/ null（未观测）。
// null 绝不能被 UI 读成死亡：模型 Sandbox 工具路径创建实例后，投影在任何
// 已确认写入触碰前保持 null，UI 回退工具卡证据旧语义。

test("沙盒投影初始态为未观测（revision 0 / alive null），不是死亡", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-sandbox");
  assert.deepEqual(publisher.getSnapshot().sandbox, { revision: 0, alive: null });
});

test("同值重复直推无操作：不产 delta、不 bump revision", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-sandbox");
  const subscribed = publisher.subscribeReserved({
    connectionId: "connection-1",
    deliveryProfile: "replayable",
  });
  assert.equal(subscribed.reservation?.commit(), true);

  publisher.publishSandboxState(false);
  publisher.publishSandboxState(false);
  assert.deepEqual(publisher.getSnapshot().sandbox, { revision: 1, alive: false });
  const flushed = publisher.reserveFlush(subscribed.ack.subscriptionId);
  assert.ok(flushed);
  assert.equal(flushed.commit(), true);
  // 同值再推：无新帧。
  publisher.publishSandboxState(false);
  assert.equal(publisher.reserveFlush(subscribed.ack.subscriptionId), null);
});

test("实例诞生直推：revision +1，订阅者下一帧收到 sandbox patch", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-sandbox");
  const subscribed = publisher.subscribeReserved({
    connectionId: "connection-1",
    deliveryProfile: "replayable",
  });
  assert.equal(subscribed.reservation?.commit(), true);

  publisher.publishSandboxState(true);
  const sandbox = publisher.getSnapshot().sandbox;
  assert.equal(sandbox?.alive, true);
  assert.equal(sandbox?.revision, 1);

  const flushed = publisher.reserveFlush(subscribed.ack.subscriptionId);
  assert.ok(flushed);
  assert.equal(flushed.frame.payload.kind, "deltas");
  if (flushed.frame.payload.kind !== "deltas") return;
  const patch = flushed.frame.payload.deltas.find((delta) => delta.op === "state.updated");
  assert.deepEqual(patch, {
    op: "state.updated",
    patch: { sandbox: { revision: 1, alive: true } },
  });
  assert.equal(flushed.commit(), true);
});

test("三态翻转序列 null→true→false→true：每次落定各 +1，不被去重吞掉", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-sandbox");
  publisher.publishSandboxState(true);
  assert.deepEqual(publisher.getSnapshot().sandbox, { revision: 1, alive: true });
  publisher.publishSandboxState(false);
  assert.deepEqual(publisher.getSnapshot().sandbox, { revision: 2, alive: false });
  publisher.publishSandboxState(true);
  assert.deepEqual(publisher.getSnapshot().sandbox, { revision: 3, alive: true });
});

test("schema 回归：快照与补丁均可通过 shared 校验（含旧快照缺席兼容）", async () => {
  const shared = await import("@zcode/shared/zcode-protocol-v4");
  const publisher = new ConversationTopicPublisher(SESSION_ID, "epoch-sandbox");
  publisher.publishSandboxState(true);
  const snapshot = publisher.getSnapshot();
  assert.equal(shared.conversationSnapshotSchema.safeParse(snapshot).success, true);
  // 旧快照缺席 sandbox 键仍合法（optional 只服务旧快照 wire 兼容）。
  const { sandbox: _dropped, ...legacy } = snapshot;
  assert.equal(shared.conversationSnapshotSchema.safeParse(legacy).success, true);
});

// ── false→null 自愈（docs/specs/sandbox-projection-push.md 未解决问题 2）──
// 模型 Sandbox 工具成功执行必在实例上跑：成功只能证明「实例曾活着」，
// 不能证明「此刻仍活着」——所以只撤销过期的已确认死亡（false→null），
// 绝不写成 alive=true，更不碰已确认的 true。

let selfHealSeq = 0;
function selfHealEvent(type: SessionEventType, payload: unknown): SessionEvent {
  selfHealSeq += 1;
  return {
    id: `sandbox-self-heal-${selfHealSeq}`,
    sessionId: SESSION_ID,
    turnId: "turn-sandbox-self-heal",
    type,
    timestamp: new Date(1_700_000_000_000 + selfHealSeq),
    traceId: "trace-sandbox-self-heal",
    sequenceNumber: selfHealSeq,
    payload,
  } as unknown as SessionEvent;
}

function sandboxToolCycle(
  projection: ProductProjection,
  callId: string,
  success: boolean,
): ConversationDelta[] {
  projection.applyEvent(
    selfHealEvent(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "算一下",
      executionKind: "agent",
    }),
  );
  projection.applyEvent(
    selfHealEvent(SessionEventType.ToolCallScheduled, {
      toolCallId: callId,
      assistantMessageId: `assistant-${callId}`,
      toolName: "Sandbox",
      input: { description: "算一下", code: "return 1+1" },
      schedule: { parallelGroups: [[callId]], executionOrder: [callId] },
    }),
  );
  return projection.applyEvent(
    selfHealEvent(SessionEventType.ToolCallResult, {
      toolCallId: callId,
      result: success ? { success: true, content: "2" } : { success: false, content: "" },
      duration: 10,
    }),
  );
}

function sandboxPatchOf(deltas: readonly ConversationDelta[]): unknown {
  const found = deltas.find((delta) => delta.op === "state.updated");
  if (!found || found.op !== "state.updated") return undefined;
  return (found.patch as { sandbox?: unknown }).sandbox;
}

test("自愈：模型 Sandbox 成功把过期的已确认死亡撤销为未观测（false→null，revision+1）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-sandbox-self-heal");
  projection.setSandboxState(false);
  assert.deepEqual(projection.getSnapshot().sandbox, { revision: 1, alive: false });

  const deltas = sandboxToolCycle(projection, "call-self-heal", true);
  assert.deepEqual(projection.getSnapshot().sandbox, { revision: 2, alive: null });
  assert.deepEqual(sandboxPatchOf(deltas), { revision: 2, alive: null });
});

test("自愈不碰已确认的活着：alive=true 时模型 Sandbox 成功不改投影", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-sandbox-self-heal-keep");
  projection.setSandboxState(true);
  const deltas = sandboxToolCycle(projection, "call-keep-alive", true);
  assert.deepEqual(projection.getSnapshot().sandbox, { revision: 1, alive: true });
  assert.equal(sandboxPatchOf(deltas), undefined);
});

test("自愈不由失败触发：success=false 时已确认死亡保持不动", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-sandbox-self-heal-fail");
  projection.setSandboxState(false);
  const deltas = sandboxToolCycle(projection, "call-fail", false);
  assert.deepEqual(projection.getSnapshot().sandbox, { revision: 1, alive: false });
  assert.equal(sandboxPatchOf(deltas), undefined);
});
