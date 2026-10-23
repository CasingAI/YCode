import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFilesWorkbenchTabChrome,
  type FilesWorkbenchChromeRect,
} from "../src/files-workbench/filesWorkbenchTabChrome.js";
import { observeFilesWorkbenchTabChrome } from "../src/files-workbench/useFilesWorkbenchTabChrome.js";

const base = { leadingInsetPx: 0, trailingInsetPx: 0, topInsetPx: 0, heightPx: 36 };
const rect = (
  left: number,
  top: number,
  right: number,
  bottom: number,
): FilesWorkbenchChromeRect => ({ left, top, right, bottom });

test("只有水平、垂直同时相交的控件才影响 Tab，边界相接不算碰撞", () => {
  const row = rect(100, 4, 500, 40);
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row }), base);
  assert.deepEqual(
    resolveFilesWorkbenchTabChrome({ row, leadingBlocker: rect(0, 0, 100, 48) }),
    base,
  );
  assert.deepEqual(
    resolveFilesWorkbenchTabChrome({ row, trailingBlocker: rect(500, 0, 600, 48) }),
    base,
  );
  assert.deepEqual(
    resolveFilesWorkbenchTabChrome({ row, leadingBlocker: rect(0, 40, 180, 80) }),
    base,
  );
  assert.deepEqual(
    resolveFilesWorkbenchTabChrome({ row, leadingBlocker: rect(0, 0, 180, 4) }),
    base,
  );
});

test("左右单独避让与共同避让只延伸当前标签条至相交控件底边", () => {
  const row = rect(100, 4, 500, 40);
  const leadingBlocker = rect(0, 0, 180, 48);
  const trailingBlocker = rect(450, 0, 600, 44);
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row, leadingBlocker }), {
    ...base,
    leadingInsetPx: 80,
    heightPx: 44,
  });
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row, trailingBlocker }), {
    ...base,
    trailingInsetPx: 50,
    heightPx: 40,
  });
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row, leadingBlocker, trailingBlocker }), {
    ...base,
    leadingInsetPx: 80,
    trailingInsetPx: 50,
    heightPx: 44,
  });
});

test("占用区域可跨多个顶边 leaf；远端组和纵向下方组维持原布局", () => {
  const leadingBlocker = rect(0, 0, 240, 48);
  const trailingBlocker = rect(680, 0, 800, 48);
  const resolve = (row: FilesWorkbenchChromeRect) =>
    resolveFilesWorkbenchTabChrome({ row, leadingBlocker, trailingBlocker });
  assert.deepEqual(resolve(rect(0, 4, 140, 40)), { ...base, topInsetPx: 44, heightPx: 80 });
  assert.deepEqual(resolve(rect(140, 4, 420, 40)), { ...base, leadingInsetPx: 100, heightPx: 44 });
  assert.deepEqual(resolve(rect(420, 4, 680, 40)), base);
  assert.deepEqual(resolve(rect(680, 4, 800, 40)), { ...base, topInsetPx: 44, heightPx: 80 });
  assert.deepEqual(resolve(rect(0, 200, 800, 236)), base);
});

test("窄组局部下移后能恢复，96px 阈值和相交判断不读取上次行高", () => {
  const row = rect(0, 4, 160, 400);
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row, leadingBlocker: rect(0, 0, 100, 48) }), {
    ...base,
    topInsetPx: 44,
    heightPx: 80,
  });
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row, leadingBlocker: rect(0, 0, 64, 48) }), {
    ...base,
    leadingInsetPx: 64,
    heightPx: 44,
  });
  assert.deepEqual(
    resolveFilesWorkbenchTabChrome({ row, leadingBlocker: rect(0, 90, 100, 100) }),
    base,
  );
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row }), base);
  assert.deepEqual(resolveFilesWorkbenchTabChrome({ row: rect(0, 4, 80, 40) }), base);
  assert.deepEqual(
    resolveFilesWorkbenchTabChrome({
      row: rect(0, 4, 80, 40),
      leadingBlocker: rect(0, 0, 1, 48),
    }),
    { ...base, topInsetPx: 44, heightPx: 80 },
  );
});

test("左右共同侵入窄组时一次下移至较低控件底边，不累计两份 padding", () => {
  assert.deepEqual(
    resolveFilesWorkbenchTabChrome({
      row: rect(0, 4, 200, 40),
      leadingBlocker: rect(0, 0, 80, 42),
      trailingBlocker: rect(140, 0, 240, 49.25),
    }),
    { ...base, topInsetPx: 46, heightPx: 82 },
  );
});

function rowStub(bounds: FilesWorkbenchChromeRect) {
  const styles = new Map<string, string>();
  let writes = 0;
  return {
    styles,
    get writes() {
      return writes;
    },
    getBoundingClientRect: () => ({
      ...bounds,
      bottom: bounds.top + Number.parseFloat(styles.get("--files-tabbar-height") ?? "36px"),
    }),
    style: {
      setProperty: (property: string, value: string) => {
        writes++;
        styles.set(property, value);
      },
      removeProperty: (property: string) => styles.delete(property),
    },
  };
}

test("单一观察器包含交通灯前置安全区与真实窗控，尺寸变化恢复并完整清理", () => {
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let onResize = () => {};
  let disconnected = false;
  const observed = new Set<unknown>();
  const listeners = new Map<string, () => void>();
  const first = rowStub(rect(54, 4, 134, 40));
  const second = rowStub(rect(134, 4, 500, 40));
  const lower = rowStub(rect(54, 200, 500, 236));
  let actionsRight = 174;
  let controlsLeft = 450;
  const actionsParent = {};
  const actions = {
    parentElement: actionsParent,
    getBoundingClientRect: () => rect(146, 9, actionsRight, 37),
  };
  const controls = { getBoundingClientRect: () => rect(controlsLeft, 9, 492, 37) };
  const scope = {
    getBoundingClientRect: () => rect(50, 0, 504, 600),
    querySelector: (selector: string) => {
      assert.equal(selector, "[data-workspace-caption-actions]");
      return actions;
    },
  };
  const surface = {
    closest: (selector: string) => {
      assert.equal(selector, "[data-workspace-shell]");
      return scope;
    },
    querySelector: (selector: string) => {
      assert.equal(selector, "[data-files-workbench-window-controls]");
      return controls;
    },
    querySelectorAll: (selector: string) => {
      assert.equal(selector, '[role="tablist"]');
      return [first, second, lower];
    },
    getBoundingClientRect: () => rect(54, 4, 500, 600),
    ownerDocument: {
      defaultView: {
        addEventListener: (event: string, listener: () => void) => listeners.set(event, listener),
        removeEventListener: (event: string, listener: () => void) => {
          assert.equal(listeners.get(event), listener);
          listeners.delete(event);
        },
      },
    },
  };
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
    const cleanup = observeFilesWorkbenchTabChrome(surface as unknown as HTMLElement);
    assert.deepEqual(
      observed,
      new Set([first, second, lower, actions, actionsParent, controls, surface]),
    );
    assert.equal(
      first.styles.get("--files-tabbar-top-inset"),
      "37px",
      "安全区包含按钮之前的原生交通灯前缀",
    );
    assert.equal(first.styles.get("--files-tabbar-height"), "73px");
    assert.equal(second.styles.get("--files-tabbar-leading-inset"), "48px");
    assert.equal(second.styles.get("--files-tabbar-trailing-inset"), "58px");
    assert.equal(second.styles.get("--files-tabbar-height"), "37px");
    assert.equal(lower.styles.get("--files-tabbar-height"), "36px");

    const writes = first.writes + second.writes + lower.writes;
    onResize();
    assert.equal(first.writes + second.writes + lower.writes, writes, "相同投影不重复写入");
    actionsRight = 146;
    controlsLeft = 492;
    listeners.get("resize")?.();
    assert.equal(first.styles.get("--files-tabbar-top-inset"), "0px");
    assert.equal(first.styles.get("--files-tabbar-height"), "36px");
    assert.equal(second.styles.get("--files-tabbar-leading-inset"), "0px");
    assert.equal(second.styles.get("--files-tabbar-trailing-inset"), "0px");

    cleanup();
    assert.equal(disconnected, true);
    assert.equal(listeners.size, 0);
    assert.equal(first.styles.size + second.styles.size + lower.styles.size, 0);
    onResize();
    assert.equal(first.styles.size, 0, "晚到的旧回调不能重新写布局变量");
  } finally {
    if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("无 workspace 时不推定左侧占用，右侧实际窗控仍参与布局", () => {
  const row = rowStub(rect(264, 0, 664, 36));
  const controls = { getBoundingClientRect: () => rect(608, 4, 656, 32) };
  const surface = {
    closest: () => null,
    querySelector: () => controls,
    querySelectorAll: () => [row],
    getBoundingClientRect: () => rect(264, 0, 664, 600),
    ownerDocument: { defaultView: null },
  };
  const cleanup = observeFilesWorkbenchTabChrome(surface as unknown as HTMLElement);
  assert.equal(row.styles.get("--files-tabbar-leading-inset"), "0px");
  assert.equal(row.styles.get("--files-tabbar-trailing-inset"), "64px");
  assert.equal(row.styles.get("--files-tabbar-height"), "36px");
  cleanup();
});
