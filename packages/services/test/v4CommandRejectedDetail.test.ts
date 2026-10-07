import assert from "node:assert/strict";
import test from "node:test";
import { assertV4CommandAckOk } from "../src/zcode-agent/zcodeV4HostCommand.js";
import type { CommandAck } from "@zcode/shared";

// 失败原因的跨进程幸存载体：RPC 错误透传白名单（rpc/channelServer.ts passthroughKeys）
// 含 `detail` 不含 `ack`。UI 依赖 `error.detail.reasonCode` 弹「为什么失败」的模态——
// detail 一旦缺失，用户就只能看到兜底文案（2026-10-08 桌面实测踩中）。

const FAILED_ACK: CommandAck = {
  status: "failed",
  reasonCode: "title.modelUnavailable",
  message: "Session title regeneration has no usable model selection",
} as CommandAck;

test("assertV4CommandAckOk：failed ACK 抛错时 detail 携带 reasonCode 与原文（跨 RPC 幸存）", () => {
  let thrown: unknown;
  try {
    assertV4CommandAckOk("regenerateSessionTitle", FAILED_ACK, "session=sess-x");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  const detail = (thrown as { detail?: { reasonCode?: string; message?: string } }).detail;
  assert.equal(detail?.reasonCode, "title.modelUnavailable");
  assert.equal(detail?.message, "Session title regeneration has no usable model selection");
  // message 字符串保留完整诊断信息（日志/兜底展示用）。
  assert.match((thrown as Error).message, /\(title\.modelUnavailable\)/);
});

test("assertV4CommandAckOk：无 reasonCode/message 的 failed ACK detail 为空对象", () => {
  let thrown: unknown;
  try {
    assertV4CommandAckOk(
      "regenerateSessionTitle",
      { status: "failed", reasonCode: "fault.command.executionFailed" } as CommandAck,
      "session=sess-x",
    );
  } catch (error) {
    thrown = error;
  }
  const detail = (thrown as { detail?: { reasonCode?: string; message?: string } }).detail;
  assert.equal(detail?.reasonCode, "fault.command.executionFailed");
  assert.equal(detail?.message, undefined);
});
