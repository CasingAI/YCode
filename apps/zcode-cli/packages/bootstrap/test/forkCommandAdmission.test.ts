import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";

function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    commandId: "fork-command",
    clientId: "client-test",
    sessionId: "session-test",
    type: "forkAssistant",
    payload: { target: { rowId: 1, entityId: "entity-1" } },
    baseRevision: 3,
    baseLogEpoch: "epoch-1",
    issuedAt: 1,
    ...overrides,
  } as CommandEnvelope;
}

test("父会话 revision 已推进时，Fork 已完成的旧消息仍被接受", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-1",
  });

  const outcome = await inbox.handle(envelope({ baseRevision: 3 }));
  assert.equal(outcome.kind, "execute");
  if (outcome.kind === "execute") outcome.settle({ status: "accepted" });
});

test("Fork 仍以投影代际为准入条件", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-2",
  });

  const outcome = await inbox.handle(envelope({ baseRevision: 3, baseLogEpoch: "epoch-1" }));
  assert.equal(outcome.kind, "ack");
  if (outcome.kind !== "ack") return;
  assert.equal(outcome.ack.status, "stale");
  assert.equal(outcome.ack.reasonCode, "proto.staleLogEpoch");
});

test("Fork 仍以行目标可解析性为准入条件", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-1",
    validateRowTarget: () => ({
      verdict: "stale",
      reasonCode: "guard.forkTargetNotStable",
    }),
  });

  const outcome = await inbox.handle(envelope({ baseRevision: 3 }));
  assert.equal(outcome.kind, "ack");
  if (outcome.kind !== "ack") return;
  assert.equal(outcome.ack.status, "stale");
  assert.equal(outcome.ack.reasonCode, "guard.forkTargetNotStable");
});

test("其他 CAS 命令的 revision 相等语义不变", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 9,
    getLogEpoch: () => "epoch-1",
  });

  const outcome = await inbox.handle(
    envelope({
      type: "editUserQuery",
      payload: { target: { rowId: 1, entityId: "entity-1" }, newText: "rewrite" },
      baseRevision: 3,
    }),
  );
  assert.equal(outcome.kind, "ack");
  if (outcome.kind !== "ack") return;
  assert.equal(outcome.ack.status, "stale");
  assert.equal(outcome.ack.reasonCode, "proto.staleRevision");
});
