import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";

function envelope(): CommandEnvelope {
  return {
    commandId: "command-idempotency-test",
    clientId: "client-test",
    sessionId: "session-test",
    type: "sendText",
    payload: { text: "hello" },
    issuedAt: 1,
  };
}

test("CommandInbox 对同一 commandId 只 admission 一次并可被 query 观察", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "log-epoch-1",
  });
  const command = envelope();

  const first = await inbox.handle(command);
  assert.equal(first.kind, "execute");
  if (first.kind !== "execute") return;

  const duplicatePromise = inbox.handle(command);
  first.settle({ status: "accepted" });
  const duplicate = await duplicatePromise;
  assert.equal(duplicate.kind, "ack");
  assert.equal(duplicate.ack.status, "duplicate");

  const query = await inbox.query([{ sessionId: command.sessionId, commandId: command.commandId }]);
  assert.ok(
    query[0]?.result !== "unknown" &&
      (query[0].result.status === "accepted" || query[0].result.status === "duplicate"),
  );
});

test("未知 commandId 的 query 保持 unknown，不伪造失败事实", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 1,
    getLogEpoch: () => "log-epoch-1",
  });
  const result = await inbox.query([{ sessionId: "session-test", commandId: "missing" }]);
  assert.equal(result[0]?.result, "unknown");
});
