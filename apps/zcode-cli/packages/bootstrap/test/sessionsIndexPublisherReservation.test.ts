import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionsIndexTopic,
  type ConversationSnapshot,
  type PendingInteractionSummary,
  type SessionPhase,
  type WorkspaceConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";
import { WorkspaceConfigPublisher } from "../src/zcode-protocol-v4/workspace-config-publisher.js";

const WORKSPACE_ID = "workspace-1";
const SESSION_ID = "session-1";
const T0 = 1_700_000_000_000;

function conversationSnapshot(
  phase: SessionPhase,
  pendingInteractions?: PendingInteractionSummary[],
): ConversationSnapshot {
  const terminal = phase.startsWith("completed") || phase === "error";
  return {
    sessionId: SESSION_ID,
    logEpoch: "session-epoch",
    revision: 1,
    control: {
      phase,
      sessionEnded: terminal,
    },
    meta: {
      title: "计划会话",
      titleSource: "generated",
    },
    rows: { window: [] },
    backgroundWorks: [],
    pendingInteractions: pendingInteractions
      ? pendingInteractions.map((summary, index) => ({
          interactionId: `interaction-${index + 1}`,
          kind: summary.userInputCount > 0 ? "userInput" : "permission",
          payload: {
            kind: summary.userInputCount > 0 ? "userInput" : "permission",
            toolName: "ExitPlanMode",
          },
        }))
      : [],
    workflowRuns: [],
  } as unknown as ConversationSnapshot;
}

function ingestSummary(
  publisher: SessionsIndexPublisher,
  phase: SessionPhase,
  pending?: PendingInteractionSummary,
): void {
  const changed = publisher.ingestConversation(conversationSnapshot(phase, pending ? [pending] : []), {
    createdAt: T0,
    lastActivityAt: T0 + 1,
  });
  assert.equal(changed, true);
}

test("发送失败回滚 reservation 后，下一帧覆盖到最新终态水位", () => {
  const publisher = new SessionsIndexPublisher(WORKSPACE_ID, "index-epoch", () => T0);
  const subscribed = publisher.subscribeReserved("connection-1");
  assert.equal(subscribed.reservation?.commit(), true);

  ingestSummary(publisher, "running", { permissionCount: 0, userInputCount: 1 });
  const failed = publisher.reserveFlush(subscribed.subscriptionId);
  assert.ok(failed);
  assert.equal(failed.frame.toSeq, 1);
  assert.equal(failed.rollback(), true);
  assert.equal(failed.rollback(), false);
  assert.equal(failed.commit(), false);

  ingestSummary(publisher, "completedSuccess");
  const retried = publisher.reserveFlush(subscribed.subscriptionId);
  assert.ok(retried);
  assert.notEqual(retried, failed);
  assert.ok(retried.logicalFrameOrdinal > failed.logicalFrameOrdinal);
  assert.equal(retried.frame.fromSeq, 0);
  assert.equal(retried.frame.toSeq, 2);
  assert.equal(retried.frame.payload.kind, "deltas");
  if (retried.frame.payload.kind === "deltas") {
    const terminal = retried.frame.payload.deltas.at(-1);
    assert.equal(terminal?.op, "session.upserted");
    if (terminal?.op === "session.upserted") {
      assert.equal(terminal.session.phase, "completedSuccess");
      assert.equal(terminal.session.pendingInteraction, undefined);
      assert.equal(terminal.session.pendingInteractionSummary, undefined);
    }
  }
  assert.equal(retried.commit(), true);
  assert.equal(retried.commit(), true);
  assert.equal(retried.rollback(), false);
  assert.equal(publisher.reserveFlush(subscribed.subscriptionId), null);
});

test("workspace-config 发送失败回滚后按原 sentSeq 重放最新 delta", () => {
  const publisher = new WorkspaceConfigPublisher(WORKSPACE_ID, "config-epoch", () => T0);
  const subscribed = publisher.subscribeReserved("connection-1");
  assert.equal(subscribed.reservation?.commit(), true);
  const first = {
    configOptions: [{ id: "model-a" }],
    slashCommands: [],
  } as unknown as WorkspaceConfigState;
  const second = {
    configOptions: [{ id: "model-b" }],
    slashCommands: [],
  } as unknown as WorkspaceConfigState;

  assert.equal(publisher.publish(first), true);
  const failed = publisher.reserveFlush(subscribed.subscriptionId);
  assert.ok(failed);
  assert.equal(failed.frame.toSeq, 1);
  assert.equal(failed.rollback(), true);

  assert.equal(publisher.publish(second), true);
  const retried = publisher.reserveFlush(subscribed.subscriptionId);
  assert.ok(retried);
  assert.equal(retried.frame.fromSeq, 0);
  assert.equal(retried.frame.toSeq, 2);
  assert.equal(retried.frame.payload.kind, "deltas");
  if (retried.frame.payload.kind === "deltas") {
    assert.equal(retried.frame.payload.deltas.length, 2);
    const latest = retried.frame.payload.deltas.at(-1);
    assert.equal(latest?.op, "config.updated");
    if (latest?.op === "config.updated") assert.equal(latest.config, second);
  }
  assert.equal(retried.commit(), true);
  assert.equal(publisher.reserveFlush(subscribed.subscriptionId), null);
});

interface GatewayTestAccess {
  indexPublishers: {
    get(workspaceId: string): SessionsIndexPublisher | undefined;
  };
  flushIndex(workspaceId: string): void;
}

test("Gateway 在线发送异常会 rollback，同一次终态 flush 不再重发旧 running 帧", async () => {
  const errors: Array<{ scope: string; error: unknown }> = [];
  const sent: unknown[] = [];
  let failPhysicalSend = true;
  const host = {
    sessionExists: () => false,
    emitWireFrame: (wire: unknown) => {
      if (failPhysicalSend) throw new Error("transport unavailable");
      sent.push(wire);
    },
    onError: (scope: string, error: unknown) => {
      errors.push({ scope, error });
    },
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    now: () => T0,
    createLogEpoch: () => "index-epoch",
  });

  try {
    const dispatch = await gateway.subscribeSessionsIndexReserved({
      topic: sessionsIndexTopic(WORKSPACE_ID),
      connectionId: "connection-1",
      clientMode: "desktop-continuous",
    });
    assert.equal(dispatch.commit(), true);
    const publisher = (gateway as unknown as GatewayTestAccess).indexPublishers.get(WORKSPACE_ID);
    assert.ok(publisher);

    ingestSummary(publisher, "running", { permissionCount: 0, userInputCount: 1 });
    (gateway as unknown as GatewayTestAccess).flushIndex(WORKSPACE_ID);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.scope, "v4.sessionsIndex.emit");

    ingestSummary(publisher, "completedSuccess");
    failPhysicalSend = false;
    (gateway as unknown as GatewayTestAccess).flushIndex(WORKSPACE_ID);
    assert.equal(sent.length, 1);
    // 正确收口时这一次 flush 已提交 terminal frame；不应还残留下一帧。
    assert.equal(publisher.reserveFlush(dispatch.ack.subscriptionId), null);
  } finally {
    gateway.dispose();
  }
});
