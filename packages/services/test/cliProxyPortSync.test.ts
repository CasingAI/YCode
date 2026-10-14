import assert from "node:assert/strict";
import test from "node:test";
import {
  isCliProxyLoopbackBaseUrl,
  resolveCliProxyProviderEndpointPatch,
  resolveCliProxyUpstreamProxyUrl,
  withCliProxyActualPort,
} from "../src/cli-proxy/cliProxy.js";

// 端口回填：只认回环地址、只改端口段；用户自定义地址不动。

test("回环地址识别：127.0.0.1/localhost（含端口/路径）", () => {
  assert.equal(isCliProxyLoopbackBaseUrl("http://127.0.0.1:8317/v1"), true);
  assert.equal(isCliProxyLoopbackBaseUrl("http://localhost:8317/v1"), true);
  assert.equal(isCliProxyLoopbackBaseUrl("http://127.0.0.1/v1"), true);
  assert.equal(isCliProxyLoopbackBaseUrl("https://api.example.com/v1"), false);
  assert.equal(isCliProxyLoopbackBaseUrl("http://192.168.1.2:8317/v1"), false);
  assert.equal(isCliProxyLoopbackBaseUrl(""), false);
});

test("让位后端口替换：只改端口，path 保留", () => {
  assert.equal(
    withCliProxyActualPort("http://127.0.0.1:8317/v1", 18317),
    "http://127.0.0.1:18317/v1",
  );
  assert.equal(
    withCliProxyActualPort("http://localhost:8317/v1", 9123),
    "http://localhost:9123/v1",
  );
});

test("端口一致时返回等值（调用方据此跳过写入）", () => {
  assert.equal(
    withCliProxyActualPort("http://127.0.0.1:8317/v1", 8317),
    "http://127.0.0.1:8317/v1",
  );
});

test("非回环地址原样返回", () => {
  const custom = "https://proxy.example.com:8317/v1";
  assert.equal(withCliProxyActualPort(custom, 18317), custom);
});

// 端点投影补丁（端口 + 数据面 api-key）：根因依据见 cliProxy.ts 注释——
// apiKey 缺失时 Registry 判 provider 配置不完整，直接排除出模型选择器（脚本复现 2026-10-14）。

test("投影补丁：缺 api-key 时补 access（含 type，满足稀疏 schema）", () => {
  assert.deepEqual(
    resolveCliProxyProviderEndpointPatch(
      { baseUrl: "http://127.0.0.1:8317/v1", apiKey: null },
      { port: 8317, dataKey: "k1" },
    ),
    { access: { type: "api-key", apiKey: "k1" } },
  );
});

test("投影补丁：端口与密钥都漂移时同时补齐", () => {
  assert.deepEqual(
    resolveCliProxyProviderEndpointPatch(
      { baseUrl: "http://127.0.0.1:8317/v1", apiKey: "stale" },
      { port: 18317, dataKey: "k2" },
    ),
    {
      baseUrl: "http://127.0.0.1:18317/v1",
      access: { type: "api-key", apiKey: "k2" },
    },
  );
});

test("投影补丁：已是最新事实时返回 null（调用方跳过写入）", () => {
  assert.equal(
    resolveCliProxyProviderEndpointPatch(
      { baseUrl: "http://127.0.0.1:18317/v1", apiKey: "k2" },
      { port: 18317, dataKey: "k2" },
    ),
    null,
  );
});

test("投影补丁：非回环地址不产生端口字段（用户自定义地址不动），密钥仍投影", () => {
  assert.deepEqual(
    resolveCliProxyProviderEndpointPatch(
      { baseUrl: "https://proxy.example.com/v1", apiKey: null },
      { port: 18317, dataKey: "k3" },
    ),
    { access: { type: "api-key", apiKey: "k3" } },
  );
});

// 上游出口代理裁决（docs/specs/plugin-cli-proxy-binary.md「上游代理」）。

test("裁决：任一提供商要求代理即写地址（代理优先），无地址/无人要求则直连", () => {
  const address = "http://127.0.0.1:7890";
  assert.equal(
    resolveCliProxyUpstreamProxyUrl(["default"], { enabled: true, address }),
    address,
  );
  assert.equal(resolveCliProxyUpstreamProxyUrl(["default"], { enabled: false, address }), null);
  // "proxy" 不受全局开关 gate；与 default 并存时代理优先（单实例共享出口）。
  assert.equal(
    resolveCliProxyUpstreamProxyUrl(["direct", "default"], { enabled: false, address }),
    null,
  );
  assert.equal(
    resolveCliProxyUpstreamProxyUrl(["direct", "proxy"], { enabled: false, address }),
    address,
  );
  // 地址未填恒直连；无提供商时不监听也就无所谓代理。
  assert.equal(resolveCliProxyUpstreamProxyUrl(["proxy"], { enabled: true, address: "  " }), null);
  assert.equal(resolveCliProxyUpstreamProxyUrl([], { enabled: true, address }), null);
});
