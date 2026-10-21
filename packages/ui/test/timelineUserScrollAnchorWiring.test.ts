import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  resolveTimelineUserScrollAnchorAdjustment,
  shouldAdjustVirtualizerForItemSizeChange,
  timelineTouchScrollIntent,
} from "../src/v4/timelineScrollAnchor.js";
import {
  isTimelineToggleAnchorDetached,
  shouldReleaseToggleAnchorOnUserScroll,
  timelineToggleAnchorAdjustment,
  timelineToggleAnchorContentAdjustment,
  timelineToggleAnchorContentOffset,
} from "../src/v4/timelineToggleAnchor.js";

const source = ts.createSourceFile(
  "ConversationTimeline.tsx",
  await readFile(new URL("../src/v4/ConversationTimeline.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

// 执行组件实际回调，而非只匹配源码；本包没有 DOM 渲染测试环境。
function bindCallback<T>(name: string, bindings: Record<string, unknown>): T {
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
  assert.ok(initializer, `找不到时间线回调 ${name}`);
  const { outputText } = ts.transpileModule(`const callback = ${initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn callback;`)(
    ...Object.values(bindings),
  ) as T;
}

function createHarness() {
  const element = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 };
  const userScrollAnchorRef = { current: null as { key: string; start: number } | null };
  const pendingUserScrollAnchorCorrectionRef = { current: false };
  const touchClientYRef = { current: null as number | null };
  const scrollbarPointerIdRef = { current: null as number | null };
  const toggleAnchorRef = {
    current: null as {
      element: Element;
      offsetTop: number;
      contentOffset: number;
      startedAt: number;
    } | null,
  };
  let measurement = { key: "turn-a", index: 0, start: 0 };
  let active = true;
  const virtualizer = {
    getVirtualItemForOffset: () => measurement,
    get measurementsCache() {
      return [measurement];
    },
  };
  const clearUserScrollAnchor = () => {
    userScrollAnchorRef.current = null;
    pendingUserScrollAnchorCorrectionRef.current = false;
  };
  const clearToggleAnchor = () => {
    toggleAnchorRef.current = null;
  };
  const noop = () => {};
  const common = {
    useCallback: (callback: unknown) => callback,
    assistantReadingScopeKey: "assistant-reading-test",
    cancelAssistantSectionNavigation: () => {},
    scrollRef: { current: element },
    userScrollAnchorRef,
    pendingUserScrollAnchorCorrectionRef,
    virtualizer,
    clearUserScrollAnchor,
  };
  const refresh = bindCallback<() => void>("refreshUserScrollAnchor", {
    ...common,
    virtualizedUnitsRef: { current: [{ key: "turn-a" }, { key: "turn-b" }] },
  });
  const consume = bindCallback<() => { applied: boolean; adjustment: number | null }>(
    "consumeUserScrollAnchorCorrection",
    {
      ...common,
      resolveTimelineUserScrollAnchorAdjustment,
      USER_SCROLL_ANCHOR_EPSILON_PX: 0.5,
      markLayoutScrollGuard: noop,
      lastObservedScrollTopRef: { current: 0 },
      syncTurnNavigatorViewport: noop,
      cacheCurrentScrollMemoryState: noop,
      notifyScrollObserversAfterCommit: noop,
      lastPrependDebugContextRef: { current: null },
      recordConversationTimelineDebugEvent: noop,
      TIMELINE_SCROLL_DEBUG_RUN_ID: "test",
      hasActiveUserScrollInteraction: () => active,
    },
  );
  const markUserScrollIntent = bindCallback<(intent: string) => void>("markUserScrollIntent", {
    ...common,
    refreshUserScrollAnchor: refresh,
    userScrollIntentRef: { current: { intent: "none", observedAt: 0 } },
    commitFollowing: noop,
    followSuspendedRef: { current: false },
    suspendedUserTookOverRef: { current: false },
    toggleAnchorRef,
    clearToggleAnchor,
    touchClientYRef,
    scrollbarPointerIdRef,
    shouldReleaseToggleAnchorOnUserScroll,
  });
  const measureCallback = bindCallback<(item: unknown) => boolean>(
    "virtualizer.shouldAdjustScrollPositionOnItemSizeChange",
    {
      ...common,
      toggleAnchorRef: { current: null },
      suppressVirtualizerAdjustmentDuringRestoreRef: { current: false },
      isContentWidthChanging: () => false,
      hasActiveUserScrollInteraction: () => active,
      shouldSuppressTimelineScrollToBottom: Boolean,
      shouldAdjustVirtualizerForItemSizeChange,
      followingRef: { current: false },
      layoutScrollGuardUntilRef: { current: 0 },
      LAYOUT_SCROLL_GUARD_MS: 100,
      getPrependDebugRequestId: () => null,
      recordConversationTimelineDebugEvent: noop,
      userScrollIntentRef: { current: { intent: "towardBottom", observedAt: 0 } },
    },
  );
  const touchBindings = {
    ...common,
    touchClientYRef,
    markUserScrollIntent,
    timelineTouchScrollIntent,
  };
  const touchStart = bindCallback<(event: unknown) => void>(
    "handleTouchStartCapture",
    touchBindings,
  );
  const touchMove = bindCallback<(event: unknown) => void>("handleTouchMoveCapture", touchBindings);
  return {
    element,
    refresh,
    consume,
    markUserScrollIntent,
    userScrollAnchorRef,
    pendingUserScrollAnchorCorrectionRef,
    toggleAnchorRef,
    touchClientYRef,
    scrollbarPointerIdRef,
    touchStart(clientY: number) {
      touchStart({ touches: [{ clientY }] });
    },
    touchMove(clientY: number) {
      touchMove({ touches: [{ clientY }] });
    },
    measure(start: number) {
      assert.equal(measureCallback({ index: 0, start: 0, end: 0, size: 40 }), false);
      measurement = { ...measurement, start };
    },
    switchVisibleTurn() {
      measurement = { key: "turn-b", index: 1, start: 300 };
    },
    stop() {
      active = false;
    },
  };
}

for (const intent of ["towardBottom", "awayFromBottom"]) {
  test(`${intent}：内容起点不变，提交先于 scroll 回调时不撤销手动滚动`, () => {
    const h = createHarness();
    h.element.scrollTop = 300;
    h.markUserScrollIntent(intent);
    h.element.scrollTop += intent === "towardBottom" ? 180 : -180;
    h.measure(0);
    const expected = h.element.scrollTop;
    assert.equal(h.consume().adjustment, 0);
    assert.equal(h.element.scrollTop, expected);
  });
}

for (const scrollFirst of [true, false]) {
  test(`用户下滚与测高交错：${scrollFirst ? "scroll 先到" : "测高先到"}只补布局位移`, () => {
    const h = createHarness();
    h.markUserScrollIntent("towardBottom");
    h.element.scrollTop = 180;
    if (scrollFirst) h.refresh();
    h.measure(40);
    if (!scrollFirst) h.refresh();
    assert.equal(h.consume().adjustment, 40);
    assert.equal(h.element.scrollTop, 220);
    assert.equal(h.userScrollAnchorRef.current?.start, 40);
    assert.equal(h.pendingUserScrollAnchorCorrectionRef.current, false);
    assert.equal(h.consume().applied, false);
    assert.equal(h.element.scrollTop, 220);
    h.measure(70);
    assert.equal(h.consume().adjustment, 30);
    assert.equal(h.element.scrollTop, 250);
  });
}

test("待结算期间手指继续移动并跨 turn，不丢掉原布局位移", () => {
  const h = createHarness();
  h.touchStart(500);
  h.touchMove(400);
  h.element.scrollTop = 180;
  h.measure(40);
  h.touchMove(300);
  assert.equal(h.userScrollAnchorRef.current?.start, 0);
  h.element.scrollTop = 240;
  assert.equal(h.consume().adjustment, 40);
  assert.equal(h.element.scrollTop, 280);
  h.switchVisibleTurn();
  h.refresh();
  assert.deepEqual(h.userScrollAnchorRef.current, { key: "turn-b", start: 300 });
});

test("小于写入阈值的布局位移也推进基线，不重复累计", () => {
  const h = createHarness();
  h.refresh();
  h.measure(0.25);
  assert.equal(h.consume().applied, false);
  assert.equal(h.userScrollAnchorRef.current?.start, 0.25);
  h.measure(0.5);
  assert.equal(h.consume().applied, false);
  assert.equal(h.element.scrollTop, 0);
});

test("锚点丢失时放弃补偿，交互结束后清理基线", () => {
  const h = createHarness();
  h.refresh();
  h.measure(40);
  h.switchVisibleTurn();
  assert.equal(h.consume().applied, false);
  assert.equal(h.userScrollAnchorRef.current, null);
  h.refresh();
  h.measure(340);
  h.stop();
  h.consume();
  assert.equal(h.userScrollAnchorRef.current, null);
  assert.equal(h.pendingUserScrollAnchorCorrectionRef.current, false);
});

// 折叠锚点 × 用户滚动：这是「滚到底部又被弹回固定位置」循环的现场。
// 用户下滚时锚点必须让位，内容变化补偿也不能把用户的滚动量写回去。

function registerToggleAnchor(h: ReturnType<typeof createHarness>) {
  h.toggleAnchorRef.current = {
    element: {} as Element,
    offsetTop: 100,
    contentOffset: 100,
    startedAt: Date.now() - 100,
  };
}

for (const intent of ["towardBottom", "awayFromBottom"]) {
  test(`用户${intent === "towardBottom" ? "下滚" : "上滚"}立即释放折叠锚点`, () => {
    const h = createHarness();
    registerToggleAnchor(h);
    h.markUserScrollIntent(intent);
    assert.equal(h.toggleAnchorRef.current, null);
  });
}

test("手指按在屏幕上时不释放折叠锚点", () => {
  const h = createHarness();
  registerToggleAnchor(h);
  h.touchStart(500);
  h.touchMove(400);
  assert.notEqual(h.toggleAnchorRef.current, null);
});

test("没有折叠锚点时用户滚动不产生副作用", () => {
  const h = createHarness();
  h.markUserScrollIntent("towardBottom");
  assert.equal(h.toggleAnchorRef.current, null);
});

/** 折叠锚点补偿的接线 harness：模拟滚动容器与锚点元素的视口位置。 */
function createToggleAnchorHarness() {
  const state = { scrollTop: 0, anchorViewportTop: 100 };
  const element = {
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(value: number) {
      state.scrollTop = value;
    },
    scrollHeight: 5000,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 0 }),
  };
  const anchorElement = {
    getBoundingClientRect: () => ({ top: state.anchorViewportTop }),
  };
  const toggleAnchorRef = {
    current: {
      element: anchorElement as unknown as Element,
      offsetTop: 100,
      contentOffset: timelineToggleAnchorContentOffset({ viewportOffset: 100, scrollTop: 0 }),
      startedAt: Date.now(),
    } as {
      element: Element;
      offsetTop: number;
      contentOffset: number;
      startedAt: number;
    } | null,
  };
  const compensateToggleAnchor = bindCallback<
    (element: unknown, mode: "content-change" | "scroll-restore") => boolean
  >("compensateToggleAnchor", {
    useCallback: (callback: unknown) => callback,
    toggleAnchorRef,
    clearToggleAnchor: () => {
      toggleAnchorRef.current = null;
    },
    markLayoutScrollGuard: () => {},
    lastObservedScrollTopRef: { current: 0 },
    syncTurnNavigatorViewport: () => {},
    cacheCurrentScrollMemoryState: () => {},
    renewToggleAnchor: () => {},
    timelineToggleAnchorContentAdjustment,
    timelineToggleAnchorContentOffset,
    timelineToggleAnchorAdjustment,
    isTimelineToggleAnchorDetached,
  });
  return { state, element, toggleAnchorRef, compensateToggleAnchor };
}

test("内容变化补偿不撤销用户下滚：滚到底后不再被弹回", () => {
  const h = createToggleAnchorHarness();
  // 用户向下滚 250px：锚点元素在视口里同步上移 250，内容坐标不变。
  h.state.scrollTop = 250;
  h.state.anchorViewportTop = -150;
  h.compensateToggleAnchor(h.element, "content-change");
  assert.equal(h.state.scrollTop, 250);
});

test("内容在锚点上方增长时按内容坐标补偿，被点的那行不动", () => {
  const h = createToggleAnchorHarness();
  // 内容在锚点上方长高 100px：锚点视口下移 100，内容坐标 +100。
  h.state.anchorViewportTop = 200;
  h.compensateToggleAnchor(h.element, "content-change");
  assert.equal(h.state.scrollTop, 100);
});

test("非用户滚动的回退仍走视口口径，把锚点放回点击时的位置", () => {
  const h = createToggleAnchorHarness();
  // 焦点 scroll-into-view 把锚点顶上去 60px：视口口径要把它放回 100。
  h.state.anchorViewportTop = 40;
  h.compensateToggleAnchor(h.element, "scroll-restore");
  assert.equal(h.state.scrollTop, -60);
});
