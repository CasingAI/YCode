// 手势的接线测试：本包没有 DOM 渲染环境（无 vitest / jsdom），所以用
// TypeScript Compiler API 把组件与 hook 里的真实回调抽出来执行，
// 而不是只匹配源码文本。判定逻辑本身由 workspaceShellSwipeGesture.test.ts
// 覆盖，这里只验证「事件怎么驱动判定」与「状态怎么写回去」。
//
// 产品规则见 docs/specs/workspace-shell-swipe-gesture.md。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  advanceSwipeGesture,
  createSwipeGestureState,
} from "../src/app-shell/workspaceShellSwipeGesture.js";
import { WORKSPACE_SWIPE_BLOCKED_SELECTOR } from "../src/app-shell/useWorkspaceSidebarSwipe.js";

async function loadSource(relativePath: string, scriptKind: ts.ScriptKind): Promise<ts.SourceFile> {
  const text = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return ts.createSourceFile(
    relativePath.split("/").pop() ?? relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

/** 从源码里抽出具名回调并执行，而不是只匹配源码文本。 */
function bindCallback<T>(
  source: ts.SourceFile,
  name: string,
  bindings: Record<string, unknown>,
): T {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      initializer = node.initializer;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === name
    ) {
      initializer = node.right;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer, `找不到回调 ${name}`);
  const { outputText } = ts.transpileModule(`const callback = ${initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn callback;`)(
    ...Object.values(bindings),
  ) as T;
}

const swipeHookSource = await loadSource(
  "../src/app-shell/useWorkspaceSidebarSwipe.ts",
  ts.ScriptKind.TS,
);

const layoutSource = await loadSource(
  "../src/app-shell/WorkspaceShellLayout.tsx",
  ts.ScriptKind.TSX,
);

/** 从真实外壳源码抽出手势订阅的 isEnabled 表达式并执行，避免只匹配源码文本。 */
function loadSwipeEnabledPredicate(): (params: {
  sidebarPresentation: "drawer" | "inline";
  isSidebarPanelVisible: boolean;
  shellPrimaryView: "tasks" | "files" | "settings";
  workspaceMainView: string;
}) => boolean {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(layoutSource) === "useWorkspaceSidebarSwipe"
    ) {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            property.name.getText(layoutSource) === "isEnabled"
          ) {
            initializer = property.initializer;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(layoutSource);
  assert.ok(initializer, "找不到 useWorkspaceSidebarSwipe 的 isEnabled 表达式");
  const { outputText } = ts.transpileModule(
    `const predicate = (params) => { const { sidebarPresentation, isSidebarPanelVisible, shellPrimaryView, workspaceMainView } = params; return (${initializer.getText(layoutSource)}); };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  );
  return new Function(`${outputText}\nreturn predicate;`)();
}

function createSwipeHarness(params?: { isBlockedByPath?: boolean; viewportWidthPx?: number }) {
  const sessionRef = { current: null as unknown };
  const opened: number[] = [];
  const onOpenSidebarRef = {
    current: () => {
      opened.push(opened.length);
    },
  };
  const bindings = {
    sessionRef,
    onOpenSidebarRef,
    createSwipeGestureState,
    advanceSwipeGesture,
    isSwipeBlockedByPath: () => params?.isBlockedByPath ?? false,
    window: { innerWidth: params?.viewportWidthPx ?? 390 },
  };
  const handleTouchStart = bindCallback<(event: unknown) => void>(
    swipeHookSource,
    "handleTouchStart",
    bindings,
  );
  const handleTouchMove = bindCallback<(event: unknown) => void>(
    swipeHookSource,
    "handleTouchMove",
    bindings,
  );
  const handleTouchEnd = bindCallback<() => void>(swipeHookSource, "handleTouchEnd", bindings);
  const handleTouchCancel = bindCallback<() => void>(
    swipeHookSource,
    "handleTouchCancel",
    bindings,
  );

  let identifier = 0;
  return {
    opened,
    start(clientX: number, clientY: number) {
      identifier += 1;
      handleTouchStart({
        changedTouches: [{ identifier, clientX, clientY }],
        touches: [{ identifier, clientX, clientY }],
        composedPath: () => [],
      });
    },
    move(clientX: number, clientY: number) {
      handleTouchMove({
        touches: [{ identifier, clientX, clientY }],
      });
    },
    end() {
      handleTouchEnd();
    },
    cancel() {
      handleTouchCancel();
    },
  };
}

test("大幅右滑：抬手时打开侧栏，且只打开一次", () => {
  const harness = createSwipeHarness();
  harness.start(40, 300);
  harness.move(180, 304);
  // 越过阈值（390px 视口下 98px）时只标记待打开，还没真正打开。
  assert.equal(harness.opened.length, 0);
  harness.move(220, 306);
  assert.equal(harness.opened.length, 0);
  harness.end();
  assert.equal(harness.opened.length, 1);
});

test("位移不足阈值：抬手也不打开", () => {
  const harness = createSwipeHarness();
  harness.start(40, 300);
  harness.move(100, 302);
  harness.end();
  assert.equal(harness.opened.length, 0);
});

test("竖向滑动：整个序列作废，抬手不打开", () => {
  const harness = createSwipeHarness();
  harness.start(200, 300);
  harness.move(204, 420);
  // 方向已锁定为纵向，之后即使横向位移够大也不该打开。
  harness.move(400, 430);
  harness.end();
  assert.equal(harness.opened.length, 0);
});

test("向左滑：作废，抬手不打开", () => {
  const harness = createSwipeHarness();
  harness.start(300, 300);
  harness.move(120, 302);
  harness.end();
  assert.equal(harness.opened.length, 0);
});

test("触摸被取消：不打开", () => {
  const harness = createSwipeHarness();
  harness.start(40, 300);
  harness.move(200, 302);
  harness.cancel();
  assert.equal(harness.opened.length, 0);
});

test("起手点被让位（输入区 / 横向滚动容器）：整个序列作废", () => {
  const harness = createSwipeHarness({ isBlockedByPath: true });
  harness.start(40, 300);
  harness.move(300, 302);
  harness.end();
  assert.equal(harness.opened.length, 0);
});

test("大视口需要更大的位移：视口越宽阈值越高", () => {
  // 390px 视口：阈值 98px。移动 90px 不到阈值。
  const narrow = createSwipeHarness({ viewportWidthPx: 390 });
  narrow.start(40, 300);
  narrow.move(130, 302);
  narrow.end();
  assert.equal(narrow.opened.length, 0);

  // 1200px 视口：阈值 300px。同样移动 100px 远远不够。
  const wide = createSwipeHarness({ viewportWidthPx: 1200 });
  wide.start(40, 300);
  wide.move(140, 302);
  wide.end();
  assert.equal(wide.opened.length, 0);

  // 1200px 视口下移动 300px 才够。
  const wideEnough = createSwipeHarness({ viewportWidthPx: 1200 });
  wideEnough.start(40, 300);
  wideEnough.move(340, 302);
  wideEnough.end();
  assert.equal(wideEnough.opened.length, 1);
});

test("手势订阅只属于抽屉收起态的任务会话阅读面", () => {
  const isEnabled = loadSwipeEnabledPredicate();
  const base = {
    sidebarPresentation: "drawer" as const,
    isSidebarPanelVisible: false,
    shellPrimaryView: "tasks" as const,
    workspaceMainView: "chat",
  };
  assert.equal(isEnabled(base), true);
  // 文件编辑面（含 Monaco、滚动条和文本选区）在订阅层整体排除。
  assert.equal(isEnabled({ ...base, shellPrimaryView: "files" }), false);
  assert.equal(isEnabled({ ...base, shellPrimaryView: "settings" }), false);
  assert.equal(isEnabled({ ...base, workspaceMainView: "automations" }), false);
  assert.equal(isEnabled({ ...base, workspaceMainView: "plugin-store" }), false);
  // 宽视口内联侧栏没有「打开」语义；抽屉已展开时遮罩接管触摸。
  assert.equal(isEnabled({ ...base, sidebarPresentation: "inline" }), false);
  assert.equal(isEnabled({ ...base, isSidebarPanelVisible: true }), false);
});

test("切入文件主视图后同一个触摸序列不会在任务保活层外打开侧栏", () => {
  const isEnabled = loadSwipeEnabledPredicate();
  const files = isEnabled({
    sidebarPresentation: "drawer",
    isSidebarPanelVisible: false,
    shellPrimaryView: "files",
    workspaceMainView: "chat",
  });
  assert.equal(files, false);

  // 让位链路仍保留：任务会话里的输入区、终端、Side Pane 与表格滚动条继续归各自表面。
  for (const marker of [
    '[data-workspace-sidebar-panel="true"]',
    '[data-v4-composer-dock="true"]',
    '[data-workspace-terminal-frame="true"]',
    '[data-workspace-side-pane-wrapper="true"]',
    "[data-markdown-table-virtual-scroll-track]",
  ]) {
    assert.ok(WORKSPACE_SWIPE_BLOCKED_SELECTOR.split(",").includes(marker));
  }
  assert.doesNotMatch(WORKSPACE_SWIPE_BLOCKED_SELECTOR, /monaco|scrollLeft/i);
});

const appPanelsSource = await loadSource("../src/hooks/useAppPanels.ts", ts.ScriptKind.TS);

test("showSidebar 是幂等置位，不是翻转", () => {
  const calls: unknown[] = [];
  const handleShowSidebar = bindCallback<() => void>(appPanelsSource, "handleShowSidebar", {
    useCallback: (callback: unknown) => callback,
    setIsSidebarVisible: (value: unknown) => {
      calls.push(value);
    },
  });
  handleShowSidebar();
  handleShowSidebar();
  // 两次调用都写 true：翻转语义在侧栏已展开时会把抽屉关掉。
  assert.deepEqual(calls, [true, true]);
});

test("toggleSidebar 仍然是翻转，两条写路径语义不同", () => {
  const calls: unknown[] = [];
  const handleToggleSidebar = bindCallback<() => void>(appPanelsSource, "handleToggleSidebar", {
    useCallback: (callback: unknown) => callback,
    setIsSidebarVisible: (updater: unknown) => {
      calls.push(updater);
    },
  });
  handleToggleSidebar();
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0], "function");
});
