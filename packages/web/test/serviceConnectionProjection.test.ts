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
/** 独立字段，不能塞进 connectionInfo；投影必须保持快照中的同一引用。 */
const traffic = { sentBytes: 123, receivedBytes: 456 };

test("原样传递连接状态、connectionInfo 与独立 traffic", () => {
  const projection = projectServiceConnection({
    status: "connected",
    generation: 7,
    rpcReady: true,
    connectionInfo,
    traffic,
  });

  assert.deepEqual(projection, {
    status: "connected",
    generation: 7,
    rpcReady: true,
    connectionInfo,
    traffic,
  });
  assert.equal(projection.connectionInfo, connectionInfo, "必须复用同一只读快照，不复制事实");
  assert.equal(projection.traffic, traffic, "traffic 必须复用快照引用，不复制数值");
  assert.deepEqual(projection.traffic, { sentBytes: 123, receivedBytes: 456 });
});

test("没有 connectionInfo 时仍原样保留 traffic，且不补造直连信息", () => {
  const projection = projectServiceConnection({
    status: "reconnecting",
    generation: 8,
    rpcReady: false,
    traffic,
  });

  assert.equal(projection.status, "reconnecting");
  assert.equal(projection.generation, 8);
  assert.equal(projection.rpcReady, false);
  assert.equal(projection.traffic, traffic);
  assert.equal("connectionInfo" in projection, false, "缺失时不能写入占位事实");
});

test("WebApp 把连接快照 traffic 接入同一投影并纳入 memo 依赖", () => {
  const projection = webAppSource.match(
    /projectServiceConnection\(\{([\s\S]*?)\}\),\s*\[([\s\S]*?)\],/,
  );
  assert.ok(projection, "WebApp 必须使用唯一投影函数并声明 memo 依赖");
  assert.match(projection[1], /traffic:\s*snapshot\.traffic/, "投影输入必须携带快照 traffic");
  assert.match(projection[2], /snapshot\.traffic/, "memo 依赖必须包含 snapshot.traffic");
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
