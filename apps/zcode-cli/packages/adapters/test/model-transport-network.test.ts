import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelTransportNetwork } from "../src/model/model-execution.js";

// 按模型代理模式三态（docs/specs/network-settings.md）：
// default 跟随全局 gate 后的 httpProxy；proxy 强制用 ZCODE_APP_* 材料（standalone 回落
// httpProxy，地址缺失直连）；direct 强制直连并屏蔽 env 代理候选。

const BASE = {
  httpProxy: "http://gated-proxy:7890",
  noProxy: "localhost",
  appHttpProxy: "http://app-proxy:7890",
  appNoProxy: "localhost,127.0.0.1",
  systemHttpProxy: "http://system-proxy:8888",
  systemNoProxy: "internal.corp",
};

test("default/缺省模式：完全沿用全局 gate 后的 httpProxy/noProxy", () => {
  assert.deepEqual(resolveModelTransportNetwork(undefined, BASE), {
    httpProxy: BASE.httpProxy,
    noProxy: BASE.noProxy,
  });
  assert.deepEqual(resolveModelTransportNetwork("default", BASE), {
    httpProxy: BASE.httpProxy,
    noProxy: BASE.noProxy,
  });
});

test("proxy 模式：强制使用 app 代理材料，No Proxy 用 app 材料", () => {
  assert.deepEqual(resolveModelTransportNetwork("proxy", BASE), {
    httpProxy: BASE.appHttpProxy,
    noProxy: BASE.appNoProxy,
  });
});

test("proxy 模式：standalone 无 app 材料时回落 httpProxy", () => {
  assert.deepEqual(
    resolveModelTransportNetwork("proxy", {
      httpProxy: BASE.httpProxy,
      noProxy: BASE.noProxy,
    }),
    { httpProxy: BASE.httpProxy, noProxy: BASE.noProxy },
  );
});

test("proxy 模式：无任何可用地址时直连（不报错）", () => {
  assert.deepEqual(resolveModelTransportNetwork("proxy", {}), { ignoreProxyEnv: true });
  assert.deepEqual(resolveModelTransportNetwork("proxy", { appNoProxy: "localhost" }), {
    ignoreProxyEnv: true,
  });
});

test("system 模式：强制使用系统代理材料与系统绕过规则", () => {
  assert.deepEqual(resolveModelTransportNetwork("system", BASE), {
    httpProxy: BASE.systemHttpProxy,
    noProxy: BASE.systemNoProxy,
  });
});

test("system 模式：无材料（系统未配代理或 standalone CLI）时直连，不被应用代理或 env 劫持", () => {
  assert.deepEqual(resolveModelTransportNetwork("system", {}), { ignoreProxyEnv: true });
  assert.deepEqual(
    resolveModelTransportNetwork("system", {
      httpProxy: BASE.httpProxy,
      appHttpProxy: BASE.appHttpProxy,
    }),
    { ignoreProxyEnv: true },
  );
});

test("direct 模式：无代理且屏蔽 env 代理候选", () => {
  assert.deepEqual(resolveModelTransportNetwork("direct", BASE), { ignoreProxyEnv: true });
  assert.deepEqual(resolveModelTransportNetwork("direct", {}), { ignoreProxyEnv: true });
});
