import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentRuntimeEnv } from "../src/runtime-tools/agentProxyEnv.js";
import { resolveHostProxyForUrl } from "../src/providers/api/nodeApiNetwork.js";

// 「为全局启用」（AppSettings.httpProxyEnabled）总开关：
// 只有显式 true 时代理/NoProxy 才生效；关闭（含 undefined，存量与新用户默认）一律直连。
// 自定义证书与代理无关，不受开关影响（docs/specs/network-settings.md）。

const PROXY = "http://127.0.0.1:7890";
const NO_PROXY = "localhost,127.0.0.1";

test("buildAgentRuntimeEnv：开关关闭时不注入任何代理/NoProxy env", () => {
  assert.deepEqual(buildAgentRuntimeEnv({ httpProxy: PROXY, noProxy: NO_PROXY }), {});
  assert.deepEqual(
    buildAgentRuntimeEnv({ httpProxy: PROXY, proxyEnabled: false, noProxy: NO_PROXY }),
    {},
  );
});

test("buildAgentRuntimeEnv：开关开启时代理与 NoProxy env 齐全", () => {
  const env = buildAgentRuntimeEnv({
    httpProxy: PROXY,
    proxyEnabled: true,
    noProxy: NO_PROXY,
  });
  assert.equal(env.HTTP_PROXY, PROXY);
  assert.equal(env.HTTPS_PROXY, PROXY);
  assert.equal(env.NO_PROXY, NO_PROXY);
});

test("buildAgentRuntimeEnv：自定义证书不受开关影响，关闭时仍注入 CA env", () => {
  const disabled = buildAgentRuntimeEnv({
    httpProxy: PROXY,
    proxyEnabled: false,
    caCertPath: "/tmp/root-ca.pem",
  });
  assert.equal(disabled.NODE_EXTRA_CA_CERTS, "/tmp/root-ca.pem");
  assert.equal(disabled.HTTP_PROXY, undefined);
});

test("resolveHostProxyForUrl：开关关闭时一律直连（优先于 NoProxy 判定）", () => {
  assert.equal(
    resolveHostProxyForUrl("https://api.example.com", {
      httpProxy: PROXY,
      noProxy: NO_PROXY,
    }).kind,
    "direct",
  );
  assert.equal(
    resolveHostProxyForUrl("https://api.example.com", {
      httpProxy: PROXY,
      proxyEnabled: false,
    }).kind,
    "direct",
  );
});

test("resolveHostProxyForUrl：开关开启时按原规则路由", () => {
  assert.equal(
    resolveHostProxyForUrl("https://api.example.com", {
      httpProxy: PROXY,
      proxyEnabled: true,
    }).kind,
    "proxy",
  );
  assert.equal(
    resolveHostProxyForUrl("https://localhost:3000", {
      httpProxy: PROXY,
      proxyEnabled: true,
      noProxy: "localhost",
    }).kind,
    "direct",
  );
});
