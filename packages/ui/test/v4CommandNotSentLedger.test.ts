import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { markCommandNotSent } from "@zcode/shared";
import { sendInteractionAutoResolutionSnooze } from "../src/v4/interactionAutoResolutionCommand.js";
import { sendWorkspaceHookCommand } from "../src/settings/workspaceHookReviewCommands.js";
import { pendingCommandRegistry } from "../src/v4/pendingCommandRegistry.js";

function notSentConnectionClosed(): Error {
  const error = new Error("fault.connection.closed");
  error.name = "ConnectionClosed";
  return markCommandNotSent(error);
}

function sentConnectionClosed(): Error {
  const error = new Error("fault.connection.closed");
  error.name = "ConnectionClosed";
  return error;
}

test("断线期未上送的 interaction 命令不留 unknown 提示", async () => {
  const sessionId = "session-snooze-not-sent";
  const accepted = await sendInteractionAutoResolutionSnooze({
    sessionId,
    interactionId: "interaction-1",
    sendCommand: () => Promise.reject(notSentConnectionClosed()),
    source: "dialog",
  });

  assert.equal(accepted, false);
  assert.equal(pendingCommandRegistry.list(sessionId).length, 0);
  assert.equal(pendingCommandRegistry.listRecoverable(sessionId).length, 0);
});

test("已上送但 ACK 丢失的 interaction 命令仍保留 unknown 线索", async () => {
  const sessionId = "session-snooze-interrupted";
  const accepted = await sendInteractionAutoResolutionSnooze({
    sessionId,
    interactionId: "interaction-2",
    sendCommand: () => Promise.reject(sentConnectionClosed()),
    source: "taskBadge",
  });

  assert.equal(accepted, false);
  const entry = pendingCommandRegistry.listRecoverable(sessionId)[0];
  assert.equal(entry?.recovery?.kind, "unknown");
  assert.equal(
    entry?.recovery?.kind === "unknown" && entry.recovery.reason,
    "transport-interrupted",
  );
  for (const item of pendingCommandRegistry.list(sessionId)) {
    pendingCommandRegistry.settle(item.sessionId, item.commandId);
  }
});

test("hook 审核命令在断线期未上送时同样结算为未发送", async () => {
  const sessionId = "session-hook-not-sent";
  await assert.rejects(
    sendWorkspaceHookCommand(
      { sendCommand: () => Promise.reject(notSentConnectionClosed()) },
      sessionId,
      "requestWorkspaceHookReview",
      { sessionId } as never,
    ),
    (error: Error) => error.name === "ConnectionClosed",
  );

  assert.equal(pendingCommandRegistry.list(sessionId).length, 0);
  assert.equal(pendingCommandRegistry.listRecoverable(sessionId).length, 0);
});

test("hook 审核命令在 ACK 丢失时保留 unknown 线索", async () => {
  const sessionId = "session-hook-interrupted";
  const settled: string[] = [];
  const sendCommand = (envelope: CommandEnvelope) => {
    settled.push(envelope.commandId);
    return Promise.reject(sentConnectionClosed());
  };
  await assert.rejects(
    sendWorkspaceHookCommand(
      { sendCommand, onCommandSettled: (commandId: string) => settled.push(commandId) },
      sessionId,
      "respondWorkspaceHookReview",
      { sessionId } as never,
    ),
    (error: Error) => error.name === "ConnectionClosed",
  );

  const entry = pendingCommandRegistry.listRecoverable(sessionId)[0];
  assert.equal(entry?.recovery?.kind, "unknown");
  assert.equal(settled.length, 2);
  for (const item of pendingCommandRegistry.list(sessionId)) {
    pendingCommandRegistry.settle(item.sessionId, item.commandId);
  }
});
