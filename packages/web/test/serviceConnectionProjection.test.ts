import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { WebConnectionInfo } from "@zcode/shared";
import { projectServiceConnection } from "../src/connection/serviceConnectionProjection.js";

/** 连接快照只读投影：不新增服务、store 或第二份连接事实。 */

const webAppSource = readFileSync(new URL("../src/WebApp.tsx", import.meta.url), "utf8");

const connectionInfo: WebConnectionInfo = {
  transport: "webrtc",
  directState: "connected",
  endpoint: "wss://remote.example.com",
};

test("原样传递连接状态与 connectionInfo", () => {
  const projection = projectServiceConnection({
    status: "connected",
    generation: 7,
    rpcReady: true,
    connectionInfo,
  });

  assert.deepEqual(projection, {
    status: "connected",
    generation: 7,
    rpcReady: true,
    connectionInfo,
  });
  assert.equal(projection.connectionInfo, connectionInfo, "必须复用同一只读快照，不复制事实");
});

test("没有 connectionInfo 时不补造直连信息", () => {
  const projection = projectServiceConnection({
    status: "reconnecting",
    generation: 8,
    rpcReady: false,
  });

  assert.equal(projection.status, "reconnecting");
  assert.equal(projection.generation, 8);
  assert.equal(projection.rpcReady, false);
  assert.equal("connectionInfo" in projection, false, "缺失时不能写入占位事实");
});

test("WebApp 通过同一投影接入 Root，不另建连接或 store", () => {
  assert.match(webAppSource, /projectServiceConnection\(\{/, "WebApp 必须使用唯一投影函数");
  assert.match(
    webAppSource,
    /connectionInfo: snapshot\.connectionInfo/,
    "投影来源必须是既有连接快照",
  );
  assert.doesNotMatch(
    webAppSource,
    /new WebSocket|RTCPeerConnection|createStore\(/,
    "投影不得创建连接、peer 或新 store",
  );
});
