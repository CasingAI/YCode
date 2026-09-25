import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceServiceReadiness } from "../src/hooks/useWorkspaceServices.js";

test("transport 断线时本地目标仍可保持会话数据层挂载", () => {
  assert.deepEqual(resolveWorkspaceServiceReadiness(false, "local-ready"), {
    targetReady: true,
    rpcReady: false,
  });
});

test("transport 断线时已解析的远程目标仍可保持会话数据层挂载", () => {
  assert.deepEqual(resolveWorkspaceServiceReadiness(false, "remote-ready"), {
    targetReady: true,
    rpcReady: false,
  });
});

test("尚未解析远程 attachment 时目标与 RPC 都不就绪", () => {
  assert.deepEqual(resolveWorkspaceServiceReadiness(true, "remote-waiting"), {
    targetReady: false,
    rpcReady: false,
  });
});

test("transport 与目标都就绪时才允许新 RPC", () => {
  assert.deepEqual(resolveWorkspaceServiceReadiness(true, "local-ready"), {
    targetReady: true,
    rpcReady: true,
  });
  assert.deepEqual(resolveWorkspaceServiceReadiness(true, "remote-ready"), {
    targetReady: true,
    rpcReady: true,
  });
});
