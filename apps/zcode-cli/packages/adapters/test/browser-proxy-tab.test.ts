// CLI headless CDP 后端的代理标签页边界（docs/specs/browser-tab-proxy.md）：
// newTab proxy:true 必须在浏览器冷启动之前就报 capability_unsupported，
// 不允许先拉起 Chromium 再拒绝，也不允许静默降级为普通 tab。
// 本文件不启动浏览器、不连接正在运行的 YCode：launchServer/connect 全部注入 fake。
import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import {
  createManagedCdpBrowserRuntime,
  type ManagedCdpBrowserRuntime,
  type PlaywrightChromiumModule,
} from "../src/browser/index.js";

function createFakeRuntime() {
  const launchServerCalls: unknown[] = [];
  const fakeServer = {
    process: () => ({ pid: 4321 }),
    wsEndpoint: () => "ws://127.0.0.1:1/trace",
    close: async () => {},
  };
  const fakeBrowser = {
    isConnected: () => true,
    on: () => {},
    close: async () => {},
    contexts: () => [],
  };
  const fakePlaywright = {
    chromium: {
      executablePath: () => "",
      launchServer: async (options: unknown) => {
        launchServerCalls.push(options);
        return fakeServer;
      },
      connect: async () => fakeBrowser,
    },
  } as unknown as PlaywrightChromiumModule;
  // process.execPath（node.exe）真实存在，用于通过显式路径校验；启动本身被 fake 接管。
  const runtime: ManagedCdpBrowserRuntime = createManagedCdpBrowserRuntime({
    executablePath: process.execPath,
    loadPlaywright: async () => fakePlaywright,
  });
  return { runtime, launchServerCalls };
}

test("newTab proxy:true 在启动浏览器前报 capability_unsupported", async () => {
  const { runtime, launchServerCalls } = createFakeRuntime();
  try {
    const port = runtime.browserControlPort;
    const [descriptor] = await port.list({ sessionId: "session-1" });
    assert.ok(descriptor, "list 未返回 backend descriptor");
    const launchesBeforeProxyCommand = launchServerCalls.length;

    const result = await port.execute({
      browserId: descriptor.id,
      browserGeneration: descriptor.generation,
      sessionId: "session-1",
      command: { method: "newTab", proxy: true },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "capability_unsupported");
    assert.equal(result.error?.sideEffect, "none");
    assert.match(result.error?.message ?? "", /desktop embedded browser/i);
    // 报错路径不得引发第二次浏览器冷启动。
    assert.equal(launchServerCalls.length, launchesBeforeProxyCommand);
  } finally {
    await runtime.close();
  }
});
