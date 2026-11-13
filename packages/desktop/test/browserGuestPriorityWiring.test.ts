import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { __clearWebContents, __setWebContents } from "./helpers/electronStub.mjs";
import { BrowserGuestManager } from "../src/main/browserView/browserGuestManager.js";

type Listener = (...args: unknown[]) => void;

interface FakeGuestOptions {
  id: number;
  pid: number;
  type?: string;
}

/**
 * 最小 fake `<webview>`：只实现 attachGuest 及其监听接线实际读取的面。
 * 优先级通过注入的 lower 观察，不读取也不修改任何真实进程。
 */
function createFakeGuest(options: FakeGuestOptions) {
  const emitter = new EventEmitter();
  let pid = options.pid;
  let destroyed = false;
  let attached = false;
  const guest = {
    id: options.id,
    mainFrame: { url: "https://example.com/", name: "", parent: null },
    getType: () => options.type ?? "webview",
    getOSProcessId: () => pid,
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
    close: (watchers?: { waitForBeforeUnload?: boolean }) => {
      void watchers;
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
    on(event: string, listener: Listener) {
      emitter.on(event, listener);
    },
    once(event: string, listener: Listener) {
      emitter.once(event, listener);
    },
    removeListener(event: string, listener: Listener) {
      emitter.removeListener(event, listener);
    },
    // 测试驱动面
    emit(event: string) {
      emitter.emit(event);
    },
    setPid(next: number) {
      pid = next;
    },
    listenerCount(event: string) {
      return emitter.listenerCount(event);
    },
  };
  return guest;
}

function createManager(lower: (pid: number, priority: "idle") => void) {
  return new BrowserGuestManager(
    undefined, // log
    undefined, // attachTimeoutMs
    undefined, // onCloseTabRequested
    undefined, // onOpenTabRequested
    undefined, // onVisibilityChanged
    undefined, // onViewportChanged
    undefined, // resizeScreenshotToCssPixels
    undefined, // screenshotSurfaceCoordinator
    undefined, // residencyOptions
    undefined, // resolveOwnerWindow
    undefined, // cdpIdleReleaseMs
    { isProtectedPid: (pid) => pid === 4_242, lower },
  );
}

function attach(manager: BrowserGuestManager, guest: ReturnType<typeof createFakeGuest>) {
  __setWebContents([guest]);
  return manager.attachGuest("tab-1", guest.id, {
    active: true,
    windowId: 1,
    workspaceKey: "/workspace",
    sessionId: "session-1",
  });
}

test("attach 后对已登记 guest renderer 应用 idle", () => {
  const calls: number[] = [];
  const manager = createManager((pid, priority) => {
    assert.equal(priority, "idle");
    calls.push(pid);
  });
  const guest = createFakeGuest({ id: 101, pid: 5001 });
  try {
    const result = attach(manager, guest);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [5001]);
  } finally {
    manager.disposeAll();
    __clearWebContents();
  }
});

test("主 frame 导航提交与加载完成后对新 renderer PID 重应用 idle", () => {
  const attachedCalls: number[] = [];
  const manager = createManager((pid) => attachedCalls.push(pid));
  const guest = createFakeGuest({ id: 102, pid: 6001 });
  try {
    attach(manager, guest);
    // 跨源导航：renderer 进程换 PID
    guest.setPid(6002);
    guest.emit("did-navigate");
    guest.setPid(6003);
    guest.emit("dom-ready");
    guest.setPid(6004);
    guest.emit("did-finish-load");
    assert.deepEqual(attachedCalls, [6001, 6002, 6003, 6004]);
  } finally {
    manager.disposeAll();
    __clearWebContents();
  }
});

test("与 Main 或主 UI renderer 共享 PID 时跳过，避免连带降低主界面", () => {
  const calls: number[] = [];
  const manager = createManager((pid) => calls.push(pid));
  const guest = createFakeGuest({ id: 103, pid: 4_242 });
  try {
    attach(manager, guest);
    guest.emit("did-navigate");
    assert.deepEqual(calls, []);
  } finally {
    manager.disposeAll();
    __clearWebContents();
  }
});

test("关闭 tab 后注销 guest 事件监听，后续导航不再降级", () => {
  const calls: number[] = [];
  const manager = createManager((pid) => calls.push(pid));
  const guest = createFakeGuest({ id: 104, pid: 7001 });
  try {
    attach(manager, guest);
    assert.ok(guest.listenerCount("did-navigate") > 0);
    manager.disposeAll();
    assert.equal(guest.listenerCount("did-navigate"), 0);
    assert.equal(guest.listenerCount("dom-ready"), 0);
    assert.equal(guest.listenerCount("did-finish-load"), 0);
    guest.setPid(7002);
    guest.emit("did-navigate");
    assert.deepEqual(calls, [7001]);
  } finally {
    __clearWebContents();
  }
});

test("guest 换代后新 guest 接管优先级，旧监听从 tab 上移除", () => {
  const calls: number[] = [];
  const manager = createManager((pid) => calls.push(pid));
  const first = createFakeGuest({ id: 105, pid: 8001 });
  const second = createFakeGuest({ id: 106, pid: 8002 });
  try {
    attach(manager, first);
    __setWebContents([first, second]);
    const result = manager.attachGuest("tab-1", second.id, {
      active: true,
      windowId: 1,
      workspaceKey: "/workspace",
      sessionId: "session-1",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [8001, 8002]);
    assert.equal(first.listenerCount("did-navigate"), 0);
    second.setPid(8003);
    second.emit("did-navigate");
    assert.deepEqual(calls, [8001, 8002, 8003]);
  } finally {
    manager.disposeAll();
    __clearWebContents();
  }
});

const SOURCE_ROOT = new URL("../src/main/", import.meta.url);

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, SOURCE_ROOT), "utf8");
}

test("临时 Chrome localStorage/cookie helper 在 spawn 后立即降为 idle", async () => {
  const source = await readSource("chromeLocalStorageManager.ts");
  assert.match(
    source,
    /import \{ lowerProcessPriority \} from "@zcode\/shared\/process-priority";/,
  );
  const spawnIndex = source.indexOf("const child = spawn(options.executablePath, args, {");
  const lowerIndex = source.indexOf('lowerProcessPriority(child.pid, "idle")');
  assert.ok(spawnIndex >= 0, "spawn 调用应存在");
  assert.ok(lowerIndex > spawnIndex, "降级必须发生在 spawn 返回之后");
  assert.ok(lowerIndex - spawnIndex < 400, "降级应紧随 spawn，避免中间插入异步等待");
});

test("Windows Chrome App-Bound 导入 helper 在 spawn 后立即降为 idle", async () => {
  const source = await readSource("windowsChromeAppBoundKey.ts");
  assert.match(
    source,
    /import \{ lowerProcessPriority \} from "@zcode\/shared\/process-priority";/,
  );
  const spawnIndex = source.indexOf("const child = spawn(executablePath, args, {");
  const lowerIndex = source.indexOf('lowerProcessPriority(child.pid, "idle")');
  assert.ok(spawnIndex >= 0, "spawn 调用应存在");
  assert.ok(lowerIndex > spawnIndex, "降级必须发生在 spawn 返回之后");
});

test("Desktop main 注入主界面 PID 保护，且不降低可见 guest", async () => {
  const source = await readSource("index.ts");
  assert.match(source, /isProtectedPid: \(pid\) =>/);
  assert.match(source, /pid === process\.pid/);
  assert.match(source, /getOSProcessId\(\) === pid/);
  // 可见性不得成为例外：不允许在 guest 优先级接入处按 visible/active 跳过。
  const managerSource = await readSource("browserView/browserGuestManager.ts");
  const bindStart = managerSource.indexOf("private bindGuestRendererPriority");
  const bindEnd = managerSource.indexOf("private setupCdpCrashGuard", bindStart);
  assert.ok(bindStart >= 0 && bindEnd > bindStart, "接入点应存在");
  const bindBody = managerSource.slice(bindStart, bindEnd);
  assert.doesNotMatch(bindBody, /visible|active|hidden/i);
  assert.match(bindBody, /installGuestRendererPriority/);
});
