import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  attachDesktopWindowSizePersistence,
  resolveDesktopWindowSize,
} from "../src/main/desktopWindowSize.js";

// 窗口最小宽度下探到 380px 后，三处约束必须一致：BrowserWindow 创建选项、
// 启动还原钳制、尺寸持久化钳制。任何一处仍按旧 480px 处理，用户把窗口压到
// 380px 后重启，窗口都会被弹回 480px 或持久化出错误尺寸。

const MIN_SIZE = { width: MIN_DESKTOP_WINDOW_WIDTH, height: MIN_DESKTOP_WINDOW_HEIGHT };

function fakeWindow(initial: { x: number; y: number; width: number; height: number }) {
  let normalBounds = { ...initial };
  let maximized = false;
  const handlers = new Map<string, Array<() => void>>();
  return {
    getNormalBounds: () => ({ ...normalBounds }),
    isDestroyed: () => false,
    isMaximized: () => maximized,
    on: (event: string, listener: () => void) => {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
    },
    resize(width: number, height: number) {
      normalBounds = { ...normalBounds, width, height };
      for (const listener of handlers.get("resize") ?? []) listener();
    },
  };
}

test("下限常量为 380×640", () => {
  assert.deepEqual(MIN_SIZE, { width: 380, height: 640 });
});

test("创建选项下限：窄工作区还原时钳到 380px，不低于下限", () => {
  const restored = resolveDesktopWindowSize(
    { width: 300, height: 500 },
    { width: 400, height: 700 },
  );
  assert.deepEqual(restored, { width: 380, height: 640, maximized: false });
});

test("创建选项下限：工作区比下限还窄时仍取下限", () => {
  const restored = resolveDesktopWindowSize(undefined, { width: 320, height: 600 });
  assert.equal(restored.width, MIN_DESKTOP_WINDOW_WIDTH);
});

test("无持久化尺寸时使用默认值 1200×800", () => {
  const restored = resolveDesktopWindowSize(undefined, { width: 1920, height: 1080 });
  assert.deepEqual(restored, { width: 1200, height: 800, maximized: false });
});

test("持久化钳制：380px 窗口的普通尺寸原样保存，不被旧下限顶回", async () => {
  const win = fakeWindow({ x: 0, y: 0, width: 380, height: 640 });
  const saved: Array<{ width: number; height: number; maximized: boolean }> = [];
  attachDesktopWindowSizePersistence(win, async (state) => {
    saved.push(state);
  });
  win.resize(380, 700);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(saved.length, 1);
  assert.deepEqual({ width: saved[0].width, height: saved[0].height }, { width: 380, height: 700 });
});
