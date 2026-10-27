import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(HERE, "../src/main.tsx"), "utf-8");

test("WebRTC 直连只在宿主能力、非 remote、安全上下文与 API 可用时启用", () => {
  assert.match(
    mainSource,
    /capability: bootstrap\.webRtcDirectAvailable === true/,
    "必须使用 server-info 声明的 webRtcDirect 能力",
  );
  assert.match(
    mainSource,
    /isRemoteRoute: params\.get\("remote"\) !== null/,
    "?remote= 路由不能自动启用直连",
  );
  assert.match(
    mainSource,
    /isSecureContext: window\.isSecureContext === true/,
    "HTTP 非安全上下文必须保持原 WSS",
  );
  assert.match(
    mainSource,
    /hasPeerConnection: typeof RTCPeerConnection === "function"/,
    "缺少 RTCPeerConnection 时不能创建 peer",
  );
  assert.match(
    mainSource,
    /connectViaWebRtcManaged\(bootstrap\.wsUrl/,
    "满足条件时走机会性 WebRTC 入口",
  );
  assert.match(
    mainSource,
    /: await connectViaWebSocketManaged\(bootstrap\.wsUrl/,
    "不满足条件时保持原 managed WSS",
  );
});
