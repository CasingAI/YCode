import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";
import { markCommandNotSent } from "@zcode/shared";
import {
  isConnectionClosedError,
  isDefinitelyUnsentCommandError,
  PendingCommandRegistry,
} from "../src/v4/pendingCommandRegistry.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function envelope(
  type: CommandEnvelope["type"],
  commandId: string,
  payload: Record<string, unknown> = {},
): CommandEnvelope {
  return {
    commandId,
    clientId: "client-test",
    sessionId: "session-test",
    type,
    payload,
    issuedAt: 1,
  };
}

test("连接中断后的 V4 命令保留为 unknown，不能被 renderer 自动重放", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 100 });
  const command = envelope("sendText", "command-unknown", { text: "hello" });

  registry.record(command);
  registry.markTransportInterrupted(command.sessionId, command.commandId);
  const entry = registry.listRecoverable(command.sessionId)[0];

  assert.equal(entry?.recovery?.kind, "unknown");
  assert.equal(
    entry?.recovery?.kind === "unknown" && entry.recovery.reason,
    "transport-interrupted",
  );
  assert.equal(
    registry.consumeReplay({ sessionId: command.sessionId, commandId: command.commandId }),
    null,
  );
});

test("query unknown 和 query unavailable 都不会删除账本", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 200 });
  const command = envelope("stop", "command-query", {});
  registry.record(command);

  const unknown: CommandsQueryResult = {
    results: [
      { key: { sessionId: command.sessionId, commandId: command.commandId }, result: "unknown" },
    ],
  };
  registry.applyQuery(unknown);
  assert.equal(registry.listRecoverable(command.sessionId)[0]?.recovery?.kind, "unknown");

  const unavailable: CommandsQueryResult = {
    results: [
      {
        key: { sessionId: command.sessionId, commandId: command.commandId },
        result: {
          commandId: command.commandId,
          status: "failed",
          reasonCode: "fault.command.queryUnavailable",
          revisionAtDecision: 0,
        },
      },
    ],
  };
  registry.applyQuery(unavailable);
  const entry = registry.listRecoverable(command.sessionId)[0];
  assert.equal(entry?.recovery?.kind, "unknown");
  assert.equal(entry?.recovery?.kind === "unknown" && entry.recovery.reason, "query-unavailable");
});

test("明确 accepted 的非重放命令立即结算，明确 discarded 的输入仅允许显式消费", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 300 });
  const control = envelope("stop", "command-control", {});
  registry.record(control);
  registry.applyAck(control, {
    commandId: control.commandId,
    status: "accepted",
    revisionAtDecision: 1,
  });
  assert.equal(registry.list(control.sessionId).length, 0);

  const input = envelope("sendText", "command-discarded", { text: "retry me" });
  registry.record(input);
  registry.applyAck(input, {
    commandId: input.commandId,
    status: "failed",
    reasonCode: "fault.command.inputDiscardedOnRestart",
    revisionAtDecision: 1,
  });
  const recovery = registry.listRecoverable(input.sessionId)[0];
  assert.equal(recovery?.recovery?.kind, "discarded");
  registry.applyQuery({
    results: [
      { key: { sessionId: input.sessionId, commandId: input.commandId }, result: "unknown" },
    ],
  });
  assert.equal(registry.listRecoverable(input.sessionId)[0]?.recovery?.kind, "discarded");
  const replay = registry.consumeReplay({ sessionId: input.sessionId, commandId: input.commandId });
  assert.equal(replay?.type, "sendText");
  assert.equal(registry.list(input.sessionId).length, 0);
});

test("accepted/duplicate 的输入先保留到 projection 证据，不生成重发入口", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 400 });
  const input = envelope("sendGoalCommand", "command-accepted", { text: "goal" });
  registry.record(input);
  registry.applyAck(input, {
    commandId: input.commandId,
    status: "duplicate",
    revisionAtDecision: 1,
  });

  assert.equal(registry.listRecoverable(input.sessionId).length, 0);
  assert.equal(registry.list(input.sessionId).length, 1);
  assert.equal(
    registry.consumeReplay({ sessionId: input.sessionId, commandId: input.commandId }),
    null,
  );
});

test("稍后可一次隐藏整组 unknown，后续对账不会把同文案条目写回", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 500 });
  const first = envelope("sendText", "command-dismiss-1", { text: "one" });
  const second = envelope("sendText", "command-dismiss-2", { text: "two" });
  registry.record(first);
  registry.record(second);
  registry.markTransportInterrupted(first.sessionId, first.commandId);
  registry.markTransportInterrupted(second.sessionId, second.commandId);

  for (const entry of registry.listRecoverable(first.sessionId)) {
    registry.dismissRecovery(entry.sessionId, entry.commandId);
  }

  assert.equal(registry.listRecoverable(first.sessionId).length, 0);
  assert.equal(registry.list(first.sessionId).length, 2);
  registry.applyQuery({
    results: [first, second].map((entry) => ({
      key: { sessionId: entry.sessionId, commandId: entry.commandId },
      result: "unknown" as const,
    })),
  });
  assert.equal(registry.listRecoverable(first.sessionId).length, 0);
});

test("断线期未上送的调用结算为未发送，不产生 unknown 提示", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 600 });
  const notSent = envelope("resolveInteraction", "command-not-sent", {});
  const interrupted = envelope("resolveInteraction", "command-interrupted", {});
  registry.record(notSent);
  registry.record(interrupted);

  const closed = new Error("fault.connection.closed");
  closed.name = "ConnectionClosed";
  assert.equal(isConnectionClosedError(closed), true);
  assert.equal(isDefinitelyUnsentCommandError(markCommandNotSent(closed)), true);
  // 未上送：调用点据此结算，账本不留下恢复线索。
  if (isDefinitelyUnsentCommandError(markCommandNotSent(closed))) {
    registry.settle(notSent.sessionId, notSent.commandId);
  } else {
    registry.markTransportInterrupted(notSent.sessionId, notSent.commandId);
  }
  // 已上送但 ACK 丢失：仍然保留 unknown 供对账。
  if (isConnectionClosedError(closed)) {
    registry.markTransportInterrupted(interrupted.sessionId, interrupted.commandId);
  }

  assert.equal(registry.list(notSent.sessionId).length, 1);
  assert.deepEqual(
    registry.listRecoverable(notSent.sessionId).map((entry) => entry.commandId),
    [interrupted.commandId],
  );
});

test("legacy unknown 线索只留账本、不进入提示", () => {
  const storage = new MemoryStorage();
  const storageKey = "zcode-v4-pending-commands:v1";
  const command = envelope("sendText", "command-legacy", { text: "legacy" });
  new PendingCommandRegistry({ storage, now: () => 600 }).record(command);

  // 回放 V4 初版写入的 legacy 字符串线索。
  const stored = JSON.parse(storage.getItem(storageKey) ?? "[]") as Record<string, unknown>[];
  storage.setItem(
    storageKey,
    JSON.stringify(stored.map((entry) => ({ ...entry, recovery: "unknown" }))),
  );

  const registry = new PendingCommandRegistry({ storage, now: () => 700 });
  assert.equal(registry.list(command.sessionId).length, 1);
  assert.equal(registry.list(command.sessionId)[0]?.recovery?.kind, "unknown");
  assert.equal(registry.listRecoverable(command.sessionId).length, 0);
});
