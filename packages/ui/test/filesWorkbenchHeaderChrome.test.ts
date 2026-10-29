import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_WORKBENCH_HEADER_GAP_PX,
  resolveFilesWorkbenchHeaderChrome,
  type FilesWorkbenchHeaderChromeRect,
} from "../src/files-workbench/filesWorkbenchHeaderChrome.js";
import { observeFilesWorkbenchHeaderChrome } from "../src/files-workbench/useFilesWorkbenchHeaderChrome.js";

const base = { leadingInsetPx: 0, trailingInsetPx: 0 };
const rect = (
  left: number,
  top: number,
  right: number,
  bottom: number,
): FilesWorkbenchHeaderChromeRect => ({ left, top, right, bottom });

test("只有真实相交的全局操作组才产生导航行避让，边界相接不算", () => {
  const row = rect(54, 0, 600, 48);
  assert.deepEqual(resolveFilesWorkbenchHeaderChrome({ row }), base);
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({ row, leadingBlocker: rect(0, 0, 54, 48) }),
    base,
  );
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({ row, trailingBlocker: rect(600, 0, 700, 48) }),
    base,
  );
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({ row, leadingBlocker: rect(12, 48, 180, 80) }),
    base,
    "行底边界相接不算相交",
  );
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({ row, leadingBlocker: rect(12, 50, 180, 80) }),
    base,
  );
});

test("左避让取操作组实际右沿加8px，不硬编码按钮宽度", () => {
  const row = rect(54, 0, 600, 48);
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({
      row,
      leadingBlocker: rect(12, 10, 174, 38),
    }),
    { ...base, leadingInsetPx: 174 + FILES_WORKBENCH_HEADER_GAP_PX - 54 },
  );
  // 更新入口显隐、侧栏宽度变化都会改变实际右沿，避让必须跟着变。
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({
      row,
      leadingBlocker: rect(12, 10, 120, 38),
    }),
    { ...base, leadingInsetPx: 120 + FILES_WORKBENCH_HEADER_GAP_PX - 54 },
  );
});

test("右侧实际控件按左沿前8px让位，左右可同时生效并夹在行宽内", () => {
  const row = rect(54, 0, 600, 48);
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({
      row,
      trailingBlocker: rect(500, 10, 600, 38),
    }),
    { ...base, trailingInsetPx: 600 - (500 - FILES_WORKBENCH_HEADER_GAP_PX) },
  );
  assert.deepEqual(
    resolveFilesWorkbenchHeaderChrome({
      row,
      leadingBlocker: rect(0, 10, 300, 38),
      trailingBlocker: rect(300, 10, 700, 38),
    }),
    { leadingInsetPx: 254, trailingInsetPx: 308 },
  );
});

test("无工作区浮层时不推定避让，导航行保持零占位", () => {
  const row = rect(0, 0, 320, 48);
  assert.deepEqual(resolveFilesWorkbenchHeaderChrome({ row }), base);
});

function headerStub(bounds: FilesWorkbenchHeaderChromeRect, getScope: () => unknown) {
  const styles = new Map<string, string>();
  let writes = 0;
  return {
    styles,
    get writes() {
      return writes;
    },
    closest: (selector: string) => {
      assert.equal(selector, "[data-workspace-shell]");
      return getScope();
    },
    getBoundingClientRect: () => bounds,
    style: {
      setProperty: (property: string, value: string) => {
        writes++;
        styles.set(property, value);
      },
      removeProperty: (property: string) => styles.delete(property),
    },
  };
}

test("单一观察器跟随操作组与窗控实际矩形写入/清理导航行变量", () => {
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let onResize = () => {};
  let disconnected = false;
  const observed = new Set<unknown>();
  const listeners = new Map<string, () => void>();
  let actionsLeft = 146;
  let actionsRight = 174;
  let controlsLeft = 500;
  const actionsParent = {};
  const actions = {
    parentElement: actionsParent,
    getBoundingClientRect: () => rect(actionsLeft, 10, actionsRight, 38),
  };
  const controls = { getBoundingClientRect: () => rect(controlsLeft, 10, 600, 38) };
  const scope = {
    getBoundingClientRect: () => rect(50, 0, 604, 600),
    querySelector: (selector: string) => {
      if (selector === "[data-workspace-caption-actions]") return actions;
      assert.equal(selector, "[data-files-workbench-window-controls]");
      return controls;
    },
  };
  const header = headerStub(rect(54, 0, 600, 48), () => scope);
  Object.assign(header, {
    ownerDocument: {
      defaultView: {
        addEventListener: (event: string, listener: () => void) => listeners.set(event, listener),
        removeEventListener: (event: string, listener: () => void) => {
          assert.equal(listeners.get(event), listener);
          listeners.delete(event);
        },
      },
    },
  });
  class ResizeObserverStub {
    constructor(callback: () => void) {
      onResize = callback;
    }
    observe(element: unknown) {
      observed.add(element);
    }
    disconnect() {
      disconnected = true;
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  try {
    const cleanup = observeFilesWorkbenchHeaderChrome(header as unknown as HTMLElement);
    assert.deepEqual(observed, new Set([header, actions, actionsParent, controls]));
    assert.equal(header.styles.get("--files-workbench-header-leading-inset"), "128px");
    assert.equal(header.styles.get("--files-workbench-header-trailing-inset"), "108px");

    const writes = header.writes;
    onResize();
    assert.equal(header.writes, writes, "相同投影不重复写入");

    actionsLeft = 12;
    actionsRight = 100;
    controlsLeft = 592;
    listeners.get("resize")?.();
    assert.equal(header.styles.get("--files-workbench-header-leading-inset"), "54px");
    assert.equal(header.styles.get("--files-workbench-header-trailing-inset"), "16px");

    cleanup();
    assert.equal(disconnected, true);
    assert.equal(listeners.size, 0);
    assert.equal(header.styles.size, 0);
    onResize();
    assert.equal(header.styles.size, 0, "晚到的旧回调不能重新写布局变量");
  } finally {
    if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});
