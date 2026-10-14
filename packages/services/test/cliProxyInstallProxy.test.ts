import assert from "node:assert/strict";
import test from "node:test";
import { resolveDownloadProxyDispatcher } from "../src/cli-proxy/cliProxyInstall.js";

// 下载器代理支持（任务：本机直连 github 被拒，需经本地代理才能下载）：
// 标准环境变量 HTTPS_PROXY/HTTP_PROXY（含 NO_PROXY），纯函数可单测。

test("无代理变量时直连", () => {
  assert.equal(
    resolveDownloadProxyDispatcher("https://github.com/x", {}),
    undefined,
  );
});

test("HTTPS 请求走 HTTPS_PROXY", () => {
  const dispatcher = resolveDownloadProxyDispatcher("https://github.com/x", {
    HTTPS_PROXY: "http://localhost:7890",
  });
  assert.ok(dispatcher);
  void dispatcher?.close?.();
});

test("小写 https_proxy 同样生效", () => {
  const dispatcher = resolveDownloadProxyDispatcher("https://github.com/x", {
    https_proxy: "http://localhost:7890",
  });
  assert.ok(dispatcher);
  void dispatcher?.close?.();
});

test("NO_PROXY 命中的主机直连", () => {
  assert.equal(
    resolveDownloadProxyDispatcher("https://github.com/x", {
      HTTPS_PROXY: "http://localhost:7890",
      NO_PROXY: "github.com",
    }),
    undefined,
  );
});

test("NO_PROXY 通配符直连", () => {
  assert.equal(
    resolveDownloadProxyDispatcher("https://example.com/x", {
      HTTPS_PROXY: "http://localhost:7890",
      NO_PROXY: "*",
    }),
    undefined,
  );
});

test("非法 URL 直连不抛错", () => {
  assert.equal(resolveDownloadProxyDispatcher("not-a-url", {}), undefined);
});
