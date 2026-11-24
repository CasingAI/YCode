import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { __clearWebContents, __setWebContents } from "./helpers/electronStub.mjs";
import {
  BrowserGuestManager,
  type BrowserGuestExecutionContext,
} from "../src/main/browserView/browserGuestManager.js";

type Listener = (...args: unknown[]) => void;

// 代理标签页创建路径（docs/specs/browser-tab-proxy.md）：newTab proxy:true 由
// resolveEmbeddedBrowserProxy 前置校验，未配置报 proxy_not_configured 且不留 tab；
// 已配置则 tab/summary/Ready 通知全程携带 usesProxy=true。

function createFakeGuest(options: { id: number; pid: number }) {
  const emitter = new EventEmitter();
  let destroyed = false;
  let attached = false;
  const guest = {
    id: options.id,
    mainFrame: { url: "https://example.com/", name: "", parent: null },
    getType: () => "webview",
    getOSProcessId: () => options.pid,
    getZoomFactor: () => 1,
    setZoomFactor: () => {},
    isDestroyed: () => destroyed,
    loadURL: async () => {},
    getURL: () => "https://example.com/",
    getTitle: () => "example",
    reload: () => {},
    stop: () => {},
    capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
    executeJavaScript: async () => undefined,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
      getAllEntries: () => [],
      getActiveIndex: () => 0,
      restore: async () => {},
    },
    close: () => {
      destroyed = true;
      emitter.emit("destroyed");
    },
    isCurrentlyAudible: () => false,
    isBeingCaptured: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      sendCommand: async () => ({}),
      on: (event: string, listener: Listener) => emitter.on(`debugger:${event}`, listener),
      removeListener: (event: string, listener: Listener) =>
        emitter.removeListener(`debugger:${event}`, listener),
    },
    on: (event: string, listener: Listener) => emitter.on(event, listener),
    once: (event: string, listener: Listener) => emitter.once(event, listener),
    removeListener: (event: string, listener: Listener) => emitter.removeListener(event, listener),
  };
  return guest;
}

function createContext(): BrowserGuestExecutionContext {
  return {
    requestId: "req-1",
    browserId: "browser-1",
    browserGeneration: 1,
    windowId: 1,
    workspaceKey: "/workspace",
    sessionId: "session-1",
    clientMode: "desktop-continuous",
  };
}

function createProxyHarness(proxyAddress: string | undefined) {
  const guests = [createFakeGuest({ id: 201, pid: 9001 }), createFakeGuest({ id: 202, pid: 9002 })];
  let guestIndex = 0;
  const openCalls: Array<{ tabId: string; usesProxy: boolean }> = [];
  let manager: BrowserGuestManager;
  manager = new BrowserGuestManager(
    undefined, // log
    20, // attachTimeoutMs：sync attach 后不会等待
    undefined, // onCloseTabRequested
    (tabId, _owner, usesProxy) => {
      openCalls.push({ tabId, usesProxy });
      // 对齐旧 renderer 行为：Ready 通知回调内同步 attach，flight 立即拿到 guest。
      const guest = guests[guestIndex];
      guestIndex += 1;
      __setWebContents([guest]);
      void manager.attachGuest(tabId, guest.id, {
        active: true,
        windowId: 1,
        workspaceKey: "/workspace",
        sessionId: "session-1",
      });
    },
    undefined, // onVisibilityChanged
    undefined, // onViewportChanged
    undefined, // resizeScreenshotToCssPixels
    undefined, // screenshotSurfaceCoordinator
    undefined, // residencyOptions
    undefined, // resolveOwnerWindow
    undefined, // cdpIdleReleaseMs
    undefined, // guestRendererPriority
    async () => proxyAddress, // resolveEmbeddedBrowserProxy
  );
  return { manager, openCalls, guests };
}

test("newTab proxy:true 已配置地址：tab 与 Ready 通知携带 usesProxy", async () => {
  const harness = createProxyHarness("127.0.0.1:7890");
  try {
    const result = await harness.manager.execute(createContext(), { method: "newTab", proxy: true });
    assert.equal(result.ok, true);
    assert.equal(result.tab?.usesProxy, true);
    assert.deepEqual(harness.openCalls, [{ tabId: result.tab!.tabId, usesProxy: true }]);

    const list = await harness.manager.execute(createContext(), { method: "list" });
    assert.equal(list.ok, true);
    assert.equal(list.tabs?.length, 1);
    assert.equal(list.tabs?.[0]?.usesProxy, true);
  } finally {
    harness.manager.disposeAll();
    __clearWebContents();
  }
});

test("newTab 不带 proxy：普通 tab usesProxy=false", async () => {
  const harness = createProxyHarness("127.0.0.1:7890");
  try {
    const result = await harness.manager.execute(createContext(), { method: "newTab" });
    assert.equal(result.ok, true);
    assert.equal(result.tab?.usesProxy, false);
    assert.deepEqual(harness.openCalls, [{ tabId: result.tab!.tabId, usesProxy: false }]);
  } finally {
    harness.manager.disposeAll();
    __clearWebContents();
  }
});

test("newTab proxy:true 未配置地址：proxy_not_configured 且不留 tab", async () => {
  const harness = createProxyHarness(undefined);
  try {
    const result = await harness.manager.execute(createContext(), { method: "newTab", proxy: true });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "proxy_not_configured");
    assert.deepEqual(harness.openCalls, []);

    const list = await harness.manager.execute(createContext(), { method: "list" });
    assert.equal(list.ok, true);
    assert.deepEqual(list.tabs, []);
  } finally {
    harness.manager.disposeAll();
    __clearWebContents();
  }
});

test("newTab proxy:true 地址为纯空白视同未配置", async () => {
  const harness = createProxyHarness("   ");
  try {
    const result = await harness.manager.execute(createContext(), { method: "newTab", proxy: true });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "proxy_not_configured");
    assert.deepEqual(harness.openCalls, []);
  } finally {
    harness.manager.disposeAll();
    __clearWebContents();
  }
});
