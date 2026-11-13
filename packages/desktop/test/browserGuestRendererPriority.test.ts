import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUEST_RENDERER_PRIORITY_EVENTS,
  installGuestRendererPriority,
  type GuestRendererPriorityTarget,
} from "../src/main/browserView/browserGuestRendererPriority.js";

type Listener = () => void;

function fakeGuest(options: {
  pid: number;
  type?: string;
  emitSupported?: boolean;
}): GuestRendererPriorityTarget & {
  pid: number;
  emit(event: string): void;
  listenerCount(event: string): number;
  destroyed: boolean;
} {
  const listeners = new Map<string, Listener[]>();
  const guest = {
    pid: options.pid,
    destroyed: false,
    getType: () => options.type ?? "webview",
    getOSProcessId: () => {
      if (guest.destroyed) throw new Error("Object has been destroyed");
      return guest.pid;
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  } as GuestRendererPriorityTarget & {
    pid: number;
    emit(event: string): void;
    listenerCount(event: string): number;
    destroyed: boolean;
  };
  if (options.emitSupported !== false) {
    guest.on = (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    };
    guest.removeListener = (event, listener) => {
      const list = listeners.get(event) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    };
  }
  return guest;
}

function recorder() {
  const calls: Array<{ pid: number; priority: string }> = [];
  return {
    calls,
    lower: (pid: number, priority: "idle") => {
      calls.push({ pid, priority });
    },
  };
}

test("attach 后首次 sync 对已登记 guest PID 应用 idle", () => {
  const guest = fakeGuest({ pid: 4321 });
  const { calls, lower } = recorder();
  installGuestRendererPriority({ guest, lower }).sync();
  assert.deepEqual(calls, [{ pid: 4321, priority: "idle" }]);
});

test("主 frame 导航提交、dom-ready、加载完成后重新读取新 PID 并重应用", () => {
  const guest = fakeGuest({ pid: 100 });
  const { calls, lower } = recorder();
  const handle = installGuestRendererPriority({ guest, lower });
  handle.sync();
  for (const event of GUEST_RENDERER_PRIORITY_EVENTS) {
    guest.pid = guest.pid + 1;
    guest.emit(event);
    assert.deepEqual(calls.at(-1), { pid: guest.pid, priority: "idle" });
  }
  assert.deepEqual(
    calls.map((call) => call.pid),
    [100, 101, 102, 103],
  );
});

test("重复事件只降不升：每次都以 idle 调用，从不传更高策略", () => {
  const guest = fakeGuest({ pid: 777 });
  const { calls, lower } = recorder();
  const handle = installGuestRendererPriority({ guest, lower });
  handle.sync();
  handle.sync();
  guest.emit("did-navigate");
  guest.emit("did-navigate");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.priority === "idle"));
});

test("与主 UI renderer 或 Main 共享 PID 时跳过", () => {
  const guest = fakeGuest({ pid: 10 });
  const { calls, lower } = recorder();
  installGuestRendererPriority({
    guest,
    lower,
    isProtectedPid: (pid) => pid === 10,
  }).sync();
  assert.equal(calls.length, 0);
});

test("非 webview guest 不降级", () => {
  const guest = fakeGuest({ pid: 11, type: "window" });
  const { calls, lower } = recorder();
  installGuestRendererPriority({ guest, lower }).sync();
  assert.equal(calls.length, 0);
});

test("无效 PID 不传给 OS", () => {
  for (const pid of [0, -1, Number.NaN, 1.5]) {
    const guest = fakeGuest({ pid });
    const { calls, lower } = recorder();
    installGuestRendererPriority({ guest, lower }).sync();
    assert.equal(calls.length, 0, `pid=${pid}`);
  }
});

test("dispose 注销全部监听且之后事件不再降低", () => {
  const guest = fakeGuest({ pid: 55 });
  const { calls, lower } = recorder();
  const handle = installGuestRendererPriority({ guest, lower });
  for (const event of GUEST_RENDERER_PRIORITY_EVENTS) {
    assert.equal(guest.listenerCount(event), 1);
  }
  handle.dispose();
  for (const event of GUEST_RENDERER_PRIORITY_EVENTS) {
    assert.equal(guest.listenerCount(event), 0);
  }
  guest.pid = 56;
  guest.emit("did-navigate");
  handle.sync();
  assert.equal(calls.length, 0);
});

test("guest 已销毁时读取 PID 抛错不传播", () => {
  const guest = fakeGuest({ pid: 60 });
  const { calls, lower } = recorder();
  const handle = installGuestRendererPriority({ guest, lower });
  guest.destroyed = true;
  assert.doesNotThrow(() => guest.emit("did-navigate"));
  assert.doesNotThrow(() => handle.sync());
  assert.equal(calls.length, 0);
});

test("缺少事件 API 时仍可一次性 sync，不抛错", () => {
  const guest = fakeGuest({ pid: 70, emitSupported: false });
  const { calls, lower } = recorder();
  const handle = installGuestRendererPriority({ guest, lower });
  assert.doesNotThrow(() => handle.sync());
  assert.doesNotThrow(() => handle.dispose());
  assert.deepEqual(calls, [{ pid: 70, priority: "idle" }]);
});
