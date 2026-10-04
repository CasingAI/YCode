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

test("连接中断后的 V4 命令保留为 unknown，禁止重放且不渲染", () => {
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
  // 账本条目必须留存到对账或 TTL：unknown 是「禁止重放」标记，不是可展示的线索。
  assert.equal(registry.list(command.sessionId).length, 1);
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

test("明确 accepted 的非重放命令立即结算，明确 discarded 的输入保留为禁止重放", () => {
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
  assert.equal(registry.listRecoverable(input.sessionId)[0]?.recovery?.kind, "discarded");
  // 显式的 discarded 事实优先于后续较弱的 unknown 查询结果。
  registry.applyQuery({
    results: [
      { key: { sessionId: input.sessionId, commandId: input.commandId }, result: "unknown" },
    ],
  });
  assert.equal(registry.listRecoverable(input.sessionId)[0]?.recovery?.kind, "discarded");
  // registry 只作禁止重放防线；时间线气泡来自服务端转录投影，本账本不产出渲染数据。
});

test("discarded 的非消息命令与空原文不产出可渲染条目", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 350 });
  const compact = envelope("compact", "command-compact", { text: "/compact" });
  const empty = envelope("sendText", "command-empty", { text: "" });
  const control = envelope("stop", "command-stop", {});
  for (const command of [compact, empty, control]) {
    registry.record(command);
    registry.applyAck(command, {
      commandId: command.commandId,
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
      revisionAtDecision: 1,
    });
  }

  assert.equal(registry.listRecoverable(compact.sessionId).length, 3);
});

test("accepted/duplicate 的输入先保留到 projection 证据，不产生恢复线索", () => {
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
});

test("unknown 在后续对账中持续留存，不会被弱查询结果冲掉", () => {
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 500 });
  const first = envelope("sendText", "command-unknown-1", { text: "one" });
  const second = envelope("sendText", "command-unknown-2", { text: "two" });
  registry.record(first);
  registry.record(second);
  registry.markTransportInterrupted(first.sessionId, first.commandId);
  registry.markTransportInterrupted(second.sessionId, second.commandId);

  assert.equal(registry.listRecoverable(first.sessionId).length, 2);
  registry.applyQuery({
    results: [first, second].map((entry) => ({
      key: { sessionId: entry.sessionId, commandId: entry.commandId },
      result: "unknown" as const,
    })),
  });
  assert.equal(registry.listRecoverable(first.sessionId).length, 2);
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

test("legacy unknown 线索迁移为标准 unknown，只留账本不渲染", () => {
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
});

test("转义失败也产出 discarded 条目，不再被静默删除", () => {
  // 回归点：判定曾认死 inputDiscardedOnRestart 一个字符串，turnLifecycleEscaped 会落到
  // settle() 被直接删除——账本不留痕迹等于凭空消失。补投失败退回结算 failed 时，
  // 客户端收到的仍是这条 reasonCode。
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 1 });
  const input = envelope("sendText", "command-escaped", { text: "turn 崩了" });
  registry.record(input);
  registry.applyAck(input, {
    commandId: input.commandId,
    status: "failed",
    reasonCode: "fault.command.turnLifecycleEscaped",
    revisionAtDecision: 1,
  });

  assert.equal(registry.listRecoverable(input.sessionId)[0]?.recovery?.kind, "discarded");
});

test("执行失败不是未送达：命令压根没 admission，账本行是 cancelled", () => {
  // executionFailed 同样带 fault. 前缀，误判成 discarded 会把一条从未落库的输入
  // 当成已送达命令放行重放。
  const registry = new PendingCommandRegistry({ storage: new MemoryStorage(), now: () => 1 });
  const input = envelope("sendText", "command-exec-failed", { text: "从没发出去" });
  registry.record(input);
  registry.applyAck(input, {
    commandId: input.commandId,
    status: "failed",
    reasonCode: "fault.command.executionFailed",
    revisionAtDecision: 1,
  });

  assert.equal(registry.listRecoverable(input.sessionId).length, 0);
});
