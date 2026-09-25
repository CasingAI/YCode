import assert from "node:assert/strict";
import test from "node:test";
import { markCommandNotSent } from "@zcode/shared";
import { toCommandTransportOutcomeError } from "../src/v4/commandTransportOutcome.js";

function connectionClosed(markNotSent: boolean): Error {
  const error = new Error("fault.connection.closed");
  error.name = "ConnectionClosed";
  return markNotSent ? markCommandNotSent(error) : error;
}

const format = (outcome: "outcomeUnknown" | "notSent") =>
  outcome === "outcomeUnknown" ? "结果未知" : "尚未发送";

test("断线期未上送的命令展示「尚未发送」，不说成结果未知", () => {
  const error = toCommandTransportOutcomeError(connectionClosed(true), format);

  assert.equal(error?.message, "尚未发送");
  assert.equal(error?.name, "ChannelClientDisposed");
});

test("已上送但 ACK 丢失仍展示结果未知", () => {
  const error = toCommandTransportOutcomeError(connectionClosed(false), format);

  assert.equal(error?.message, "结果未知");
  assert.equal(error?.name, "ConnectionClosed");
});

test("非连接类错误不做结局投影", () => {
  const error = toCommandTransportOutcomeError(new Error("provider_not_ready"), format);

  assert.equal(error, null);
});
