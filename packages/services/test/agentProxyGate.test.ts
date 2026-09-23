import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentRuntimeEnv } from "../src/runtime-tools/agentProxyEnv.js";
import { resolveHostProxyForUrl } from "../src/providers/api/nodeApiNetwork.js";
import {
  ZCODE_APP_HTTP_PROXY_ENV_KEY,
  ZCODE_APP_NO_PROXY_ENV_KEY,
  ZCODE_SYSTEM_HTTP_PROXY_ENV_KEY,
  ZCODE_SYSTEM_NO_PROXY_ENV_KEY,
} from "@zcode/shared";

// 「为全局启用」（AppSettings.httpProxyEnabled）总开关：
// 只有显式 true 时代理/NoProxy 才生效；关闭（含 undefined，存量与新用户默认）一律直连。
// ZCODE_APP_HTTP_PROXY / ZCODE_APP_NO_PROXY 是按模型代理模式「使用代理」的原始材料，
// ZCODE_SYSTEM_HTTP_PROXY / ZCODE_SYSTEM_NO_PROXY 是「系统代理设置」的材料，
// 两者都只要来源非空就注入、不受开关 gate（消费方仅限 agent 内模型 transport 的按模型分支）。
// 自定义证书与代理无关，不受开关影响（docs/specs/network-settings.md）。

const PROXY = "http://127.0.0.1:7890";
const NO_PROXY = "localhost,127.0.0.1";

test("buildAgentRuntimeEnv：开关关闭时不注入 gate 过的代理/NoProxy env，只留下按模型材料", () => {
  const env = buildAgentRuntimeEnv({ httpProxy: PROXY, noProxy: NO_PROXY });
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.ZCODE_HTTP_PROXY, undefined);
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env[ZCODE_APP_HTTP_PROXY_ENV_KEY], PROXY);
  assert.equal(env[ZCODE_APP_NO_PROXY_ENV_KEY], NO_PROXY);
});

test("buildAgentRuntimeEnv：地址未填时按模型材料也不注入（与开关无关）", () => {
  assert.deepEqual(buildAgentRuntimeEnv({ proxyEnabled: true }), {});
  assert.deepEqual(buildAgentRuntimeEnv({}), {});
  // 既有行为：开关开启时 NoProxy 独立于地址注入；这里只锁定材料键不出现。
  const blankAddress = buildAgentRuntimeEnv({
    httpProxy: "   ",
    proxyEnabled: true,
    noProxy: NO_PROXY,
  });
  assert.equal(blankAddress[ZCODE_APP_HTTP_PROXY_ENV_KEY], undefined);
  assert.equal(blankAddress[ZCODE_APP_NO_PROXY_ENV_KEY], undefined);
  const blankAddressOff = buildAgentRuntimeEnv({ httpProxy: "   ", noProxy: NO_PROXY });
  assert.deepEqual(blankAddressOff, {});
});

test("buildAgentRuntimeEnv：开关开启时 gate 键与按模型材料并存", () => {
  const env = buildAgentRuntimeEnv({
    httpProxy: PROXY,
    proxyEnabled: true,
    noProxy: NO_PROXY,
  });
  assert.equal(env.HTTP_PROXY, PROXY);
  assert.equal(env.HTTPS_PROXY, PROXY);
  assert.equal(env.NO_PROXY, NO_PROXY);
  assert.equal(env[ZCODE_APP_HTTP_PROXY_ENV_KEY], PROXY);
  assert.equal(env[ZCODE_APP_NO_PROXY_ENV_KEY], NO_PROXY);
});

test("buildAgentRuntimeEnv：系统代理材料不受开关 gate，开关关闭时仍注入", () => {
  const env = buildAgentRuntimeEnv({
    httpProxy: PROXY,
    proxyEnabled: false,
    systemProxy: { httpProxy: "http://system-proxy:8888", noProxy: "localhost" },
  });
  assert.equal(env[ZCODE_SYSTEM_HTTP_PROXY_ENV_KEY], "http://system-proxy:8888");
  assert.equal(env[ZCODE_SYSTEM_NO_PROXY_ENV_KEY], "localhost");
  assert.equal(env.HTTP_PROXY, undefined);
});

test("buildAgentRuntimeEnv：系统代理未配置或无地址时不注入材料", () => {
  const none = buildAgentRuntimeEnv({ systemProxy: undefined });
  assert.equal(none[ZCODE_SYSTEM_HTTP_PROXY_ENV_KEY], undefined);
  const blank = buildAgentRuntimeEnv({ systemProxy: { httpProxy: "   " } });
  assert.equal(blank[ZCODE_SYSTEM_HTTP_PROXY_ENV_KEY], undefined);
  const noNoProxy = buildAgentRuntimeEnv({ systemProxy: { httpProxy: PROXY } });
  assert.equal(noNoProxy[ZCODE_SYSTEM_HTTP_PROXY_ENV_KEY], PROXY);
  assert.equal(noNoProxy[ZCODE_SYSTEM_NO_PROXY_ENV_KEY], undefined);
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
