import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  resolveMcpNetwork,
} from "../src/mcp/network.js";

// 按 MCP 服务器代理四态（docs/specs/network-settings.md）：
// default 跟随全局 gate 后的 httpProxy；proxy 强制用「网络」分区地址（standalone 回落
// httpProxy，地址缺失直连）；system 走操作系统代理（无材料直连）；direct 强制直连。
// 关键回归点是 direct 必须**主动**屏蔽 env 代理候选——不注入不等于不代理。

const BASE = {
  httpProxy: "http://gated-proxy:7890",
  noProxy: "localhost",
  appHttpProxy: "http://app-proxy:7890",
  appNoProxy: "localhost,127.0.0.1",
  systemHttpProxy: "http://system-proxy:8888",
  systemNoProxy: "internal.corp",
  caCertFile: "/etc/ssl/custom-ca.pem",
};

test("default/缺省：完全沿用全局 gate 后的结果，零回归", () => {
  assert.deepEqual(resolveMcpNetwork(undefined, BASE), {
    caCertFile: BASE.caCertFile,
    httpProxy: BASE.httpProxy,
    noProxy: BASE.noProxy,
  });
  assert.deepEqual(resolveMcpNetwork("default", BASE), {
    caCertFile: BASE.caCertFile,
    httpProxy: BASE.httpProxy,
    noProxy: BASE.noProxy,
  });
});

test("proxy：强制走「网络」分区地址，No Proxy 用同一份材料", () => {
  assert.deepEqual(resolveMcpNetwork("proxy", BASE), {
    caCertFile: BASE.caCertFile,
    httpProxy: BASE.appHttpProxy,
    noProxy: BASE.appNoProxy,
  });
});

test("proxy：standalone 无 app 材料时回落 httpProxy", () => {
  assert.deepEqual(
    resolveMcpNetwork("proxy", { httpProxy: BASE.httpProxy, noProxy: BASE.noProxy }),
    { httpProxy: BASE.httpProxy, noProxy: BASE.noProxy },
  );
});

test("proxy：完全没有可用地址时判定为配置错误，不静默直连", () => {
  // 用户显式选了「使用代理」却没地址，属配置遗漏。行为上仍是直连（不会误连），
  // 但必须带 missingProxyAddress，让调用方报配置错误而不是让用户去查网络。
  assert.deepEqual(resolveMcpNetwork("proxy", {}), {
    ignoreProxyEnv: true,
    missingProxyAddress: "proxy",
  });
});

test("system：走操作系统代理材料", () => {
  assert.deepEqual(resolveMcpNetwork("system", BASE), {
    caCertFile: BASE.caCertFile,
    httpProxy: BASE.systemHttpProxy,
    noProxy: BASE.systemNoProxy,
  });
});

test("system：系统未配代理时判定为配置错误，不被应用代理劫持", () => {
  assert.deepEqual(resolveMcpNetwork("system", { appHttpProxy: BASE.appHttpProxy }), {
    ignoreProxyEnv: true,
    missingProxyAddress: "system",
  });
});

test("direct：无视全局开关强制直连，但证书照传（证书与代理无关）", () => {
  assert.deepEqual(resolveMcpNetwork("direct", BASE), {
    caCertFile: BASE.caCertFile,
    ignoreProxyEnv: true,
  });
});

test("stdio direct：子进程 env 里的代理键被真正剥掉", () => {
  // 父进程 env 同时带继承来的 HTTP_PROXY 与 ZCODE_HTTP_PROXY 一次性材料；
  // applyNetworkEgressEnv 只会注入不会删除，不显式剥就等于仍把代理地址交给子进程。
  const env = buildMcpStdioEnv({
    env: {
      PATH: "/usr/bin",
      HTTP_PROXY: "http://inherited:7890",
      HTTPS_PROXY: "http://inherited:7890",
      ALL_PROXY: "http://inherited:7890",
      http_proxy: "http://inherited:7890",
      NO_PROXY: "localhost",
      ZCODE_HTTP_PROXY: "http://material:7890",
      ZCODE_NO_PROXY: "localhost",
    } as NodeJS.ProcessEnv,
    network: resolveMcpNetwork("direct", BASE),
  });
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "NO_PROXY",
    "ZCODE_HTTP_PROXY",
    "ZCODE_NO_PROXY",
  ]) {
    assert.equal(env[key], undefined, `${key} 必须被剥掉`);
  }
  // PATH 会被 prependRunningNodeDirectory 合法地补上运行中 node 的目录，这里只断言原有条目还在。
  assert.ok(env["PATH"]?.includes("/usr/bin"), "非代理 env 不受影响");
});

test("stdio 非 direct：仍按解析结果注入代理 env", () => {
  const env = buildMcpStdioEnv({
    env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    network: resolveMcpNetwork("proxy", BASE),
  });
  assert.equal(env["HTTP_PROXY"], BASE.appHttpProxy);
  assert.equal(env["NO_PROXY"], BASE.appNoProxy);
});

test("http direct：env 里的代理候选被真正屏蔽（对比 default 会撞上死代理）", async () => {
  // 用一个必然连接失败的代理地址（127.0.0.1:1）作为区分标记：
  // 走到代理的请求会 connection refused，直连的请求能拿到本地 server 的响应。
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;

  const deadProxyEnv = {
    ZCODE_HTTP_PROXY: "http://127.0.0.1:1",
  } as NodeJS.ProcessEnv;

  try {
    // 这里刻意不带 caCertFile：本用例只验证代理候选的屏蔽，证书分支会真去读文件。
    const directFetch = createMcpTransportFetch({
      env: deadProxyEnv,
      network: resolveMcpNetwork("direct", {}),
    });
    const directResponse = await directFetch(url);
    assert.equal(directResponse.status, 200, "direct 必须无视 env 里的代理候选");

    // 对照：同样这份 env，走 default（未 gate 的 httpProxy 为空 → 回落 env 候选）会撞上死代理。
    const defaultFetch = createMcpTransportFetch({
      env: deadProxyEnv,
      network: resolveMcpNetwork("default", {}),
    });
    await assert.rejects(() => defaultFetch(url), "default 模式会使用 env 代理候选");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
