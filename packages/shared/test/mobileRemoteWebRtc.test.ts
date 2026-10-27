import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  WEB_RTC_SIGNAL_VERSION,
  serverRemoteInfoSchema,
  webRtcIdSchema,
  webRtcSignalSchema,
} from "../src/index.js";

const MAX_SDP_LENGTH = 256 * 1024;

function serverInfo(capabilities: Record<string, unknown>) {
  return {
    serverId: "server-1",
    version: "1.0.0",
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: true,
    workspaces: [{ path: "/workspace" }],
    capabilities,
  };
}

test("信令版本固定为 1", () => {
  assert.equal(WEB_RTC_SIGNAL_VERSION, 1);
});

test("offer 与 answer 接受上限内的 SDP", () => {
  const sdp = "v=0\r\n".padEnd(MAX_SDP_LENGTH, "a");
  assert.deepEqual(webRtcSignalSchema.parse({ version: 1, type: "offer", sdp }), {
    version: 1,
    type: "offer",
    sdp,
  });
  assert.deepEqual(webRtcSignalSchema.parse({ version: 1, type: "answer", sdp: "v=0" }), {
    version: 1,
    type: "answer",
    sdp: "v=0",
  });
});

test("error 只接受有限错误码", () => {
  for (const code of ["invalid-signal", "unavailable", "busy", "negotiation-failed"]) {
    assert.deepEqual(webRtcSignalSchema.parse({ version: 1, type: "error", code }), {
      version: 1,
      type: "error",
      code,
    });
  }
  assert.equal(
    webRtcSignalSchema.safeParse({ version: 1, type: "error", code: "internal-details" }).success,
    false,
  );
  assert.equal(webRtcSignalSchema.safeParse({ version: 1, type: "error" }).success, false);
});

test("ping 与 pong 只携带版本和类型", () => {
  assert.deepEqual(webRtcSignalSchema.parse({ version: 1, type: "ping" }), {
    version: 1,
    type: "ping",
  });
  assert.deepEqual(webRtcSignalSchema.parse({ version: 1, type: "pong" }), {
    version: 1,
    type: "pong",
  });
  assert.equal(webRtcSignalSchema.safeParse({ version: 1, type: "ping", sdp: "" }).success, false);
  assert.equal(
    webRtcSignalSchema.safeParse({ version: 1, type: "pong", extra: true }).success,
    false,
  );
  assert.equal(webRtcSignalSchema.safeParse({ version: 2, type: "ping" }).success, false);
  assert.equal(webRtcSignalSchema.safeParse({ type: "ping" }).success, false);
});

test("信令拒绝错误版本、未知类型与未知字段", () => {
  assert.equal(webRtcSignalSchema.safeParse({ version: 2, type: "offer", sdp: "" }).success, false);
  assert.equal(
    webRtcSignalSchema.safeParse({ version: 1, type: "candidate", sdp: "" }).success,
    false,
  );
  assert.equal(
    webRtcSignalSchema.safeParse({ version: 1, type: "offer", sdp: "", extra: true }).success,
    false,
  );
  assert.equal(
    webRtcSignalSchema.safeParse({ version: 1, type: "error", code: "busy", sdp: "" }).success,
    false,
  );
});

test("信令拒绝超长与非字符串 SDP", () => {
  const oversized = "x".repeat(MAX_SDP_LENGTH + 1);
  assert.equal(
    webRtcSignalSchema.safeParse({ version: 1, type: "offer", sdp: oversized }).success,
    false,
  );
  assert.equal(webRtcSignalSchema.safeParse({ version: 1, type: "answer", sdp: 1 }).success, false);
});

test("rtcId 只接受 UUID", () => {
  const id = randomUUID();
  assert.equal(webRtcIdSchema.parse(id), id);
  assert.equal(webRtcIdSchema.safeParse("not-a-uuid").success, false);
  assert.equal(webRtcIdSchema.safeParse("").success, false);
  assert.equal(webRtcIdSchema.safeParse(id.toUpperCase()).success, true);
});

test("server-info 能力声明 webRtcDirect 且保持可选", () => {
  const enabled = serverRemoteInfoSchema.parse(
    serverInfo({ desktopContinuous: true, websocketRpc: true, webRtcDirect: true }),
  );
  assert.equal(enabled.capabilities.webRtcDirect, true);

  const disabled = serverRemoteInfoSchema.parse(
    serverInfo({ desktopContinuous: true, websocketRpc: true, webRtcDirect: false }),
  );
  assert.equal(disabled.capabilities.webRtcDirect, false);

  const legacy = serverRemoteInfoSchema.parse(
    serverInfo({ desktopContinuous: true, websocketRpc: true }),
  );
  assert.equal(legacy.capabilities.webRtcDirect, undefined);
});
