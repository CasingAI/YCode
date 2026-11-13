import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { reconcileFollowingForContentAnchor } from "../src/v4/timelineScrollAnchor.js";

/**
 * 时间线滚动热路径的读取与通知成本约束（docs/specs/renderer-interaction-layout-cost.md 4.2/4.3）。
 *
 * 本包没有 DOM 渲染测试环境，因此沿用 AST 提取 + `new Function` 执行组件实际回调的方式：
 * 断言的是回调真实运行时的 getter 次数、派发次数与状态优先级，而不是只匹配源码文本。
 */

const timelineSource = await readFile(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

const source = ts.createSourceFile(
  "ConversationTimeline.tsx",
  timelineSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function evaluateExpression<T>(expression: ts.Expression, bindings: Record<string, unknown>): T {
  const { outputText } = ts.transpileModule(`const value = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn value;`)(
    ...Object.values(bindings),
  ) as T;
}

/** 执行组件里 `const name = ...` 或 `name = ...` 的实际回调，绑定注入的依赖。 */
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
  return evaluateExpression<T>(initializer, bindings);
}

/** 提取带标记的无依赖 layout effect 回调节点，便于同时断言“仍然无依赖”。 */
function findLayoutEffectCall(marker: string): ts.CallExpression {
  let match: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      !match &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useLayoutEffect" &&
      node.arguments[0] &&
      ts.isArrowFunction(node.arguments[0]) &&
      node.arguments[0].getText(source).includes(marker)
    ) {
      match = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(match, `找不到包含 ${marker} 的 layout effect`);
  return match;
}

/** 定位只在提交阶段推进 scroll 通知作用域的 layout effect。 */
function findScopeCommitEffect(): ts.ArrowFunction {
  let match: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (
      !match &&
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useLayoutEffect" &&
      node.arguments[0] &&
      ts.isArrowFunction(node.arguments[0]) &&
      node.arguments[0].getText(source).includes("scrollNotificationScopeRef.current")
    ) {
      match = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(match, "找不到提交阶段推进 scroll notification scope 的 layout effect");
  return match;
}

function bindScopeCommit(
  scrollNotificationScopeRef: { current: string },
  scrollMemoryKey: string | null,
  sessionKey: string,
): () => void {
  return evaluateExpression<() => void>(findScopeCommitEffect(), {
    scrollNotificationScopeRef,
    scrollMemoryKey,
    sessionKey,
  });
}

interface MetricElementInput {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** 统计每个几何 getter 的读取次数；scrollTop 写入也会被记录。 */
function createMetricElement(input: MetricElementInput) {
  const reads = { scrollTop: 0, clientHeight: 0, scrollHeight: 0 };
  const scrollTopWrites: number[] = [];
  const state = { ...input };
  const element = {
    get scrollTop() {
      reads.scrollTop += 1;
      return state.scrollTop;
    },
    set scrollTop(value: number) {
      scrollTopWrites.push(value);
      state.scrollTop = value;
    },
    get clientHeight() {
      reads.clientHeight += 1;
      return state.clientHeight;
    },
    get scrollHeight() {
      reads.scrollHeight += 1;
      return state.scrollHeight;
    },
  };
  return { element, reads, scrollTopWrites, state };
}

// ── 4.2 单次尺寸读取 ────────────────────────────────────────────────────────

test("buildCurrentScrollMemoryState 单次调用只读取一组滚动尺寸（6→3）", () => {
  const h = createMetricElement({ scrollTop: 120, clientHeight: 600, scrollHeight: 2000 });
  let receivedMetrics: unknown;
  const build = bindCallback<(element: unknown) => unknown>("buildCurrentScrollMemoryState", {
    useCallback: (callback: unknown) => callback,
    reconcileFollowingForContentAnchor,
    followingRef: { current: true },
    lastObservedScrollTopRef: { current: 0 },
    // 实现应把同一组 metrics 交给纯构造函数；这里记录它收到的对象。
    buildCurrentScrollMemoryStateFromMetrics: (metrics: unknown) => {
      receivedMetrics = metrics;
      return metrics;
    },
  });

  build(h.element);

  assert.deepEqual(
    h.reads,
    { scrollTop: 1, clientHeight: 1, scrollHeight: 1 },
    "同一次记忆构造只能各读一次，避免同帧内读到互相矛盾的几何",
  );
  assert.deepEqual(receivedMetrics, { scrollTop: 120, viewportHeight: 600, contentHeight: 2000 });
});

test("同组 metrics 同时决定 following 与返回字段", () => {
  const buildFromMetrics = bindCallback<
    (metrics: { scrollTop: number; viewportHeight: number; contentHeight: number }) => {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      wasPinnedToBottom?: boolean;
      updatedAt: number;
    }
  >("buildCurrentScrollMemoryStateFromMetrics", {
    useCallback: (callback: unknown) => callback,
    reconcileFollowingForContentAnchor,
    followingRef: { current: false },
    lastObservedScrollTopRef: { current: 0 },
  });

  const state = buildFromMetrics({ scrollTop: 1400, viewportHeight: 600, contentHeight: 2000 });

  // 距底 0：对账会恢复 following=true；返回字段必须与判定输入同源。
  assert.equal(state.wasPinnedToBottom, true);
  assert.equal(state.scrollTop, 1400);
  assert.equal(state.clientHeight, 600);
  assert.equal(state.scrollHeight, 2000);
});

test("saveCurrentScrollMemory 收到局部 metrics 时不再读取元素", () => {
  const h = createMetricElement({ scrollTop: 120, clientHeight: 600, scrollHeight: 2000 });
  const saves: Array<{ key: string; state: unknown }> = [];
  const cacheCalls: Array<unknown> = [];
  const save = bindCallback<(metrics?: unknown) => void>("saveCurrentScrollMemory", {
    useCallback: (callback: unknown) => callback,
    scrollMemoryKey: "scope-a",
    scrollRef: { current: h.element },
    pendingDetachedScrollRestoreRef: { current: null },
    latestScrollMemoryStateRef: { current: null },
    cacheCurrentScrollMemoryState: (element: unknown, metrics?: unknown) => {
      cacheCalls.push(metrics);
      if (metrics) return metrics;
      // 未收到 metrics 时会走元素实时读取，测试用读取次数区分。
      return { scrollTop: (element as { scrollTop: number }).scrollTop };
    },
    saveChatSessionScrollMemoryState: (key: string, state: unknown) => saves.push({ key, state }),
  });

  const metrics = { scrollTop: 120, viewportHeight: 600, contentHeight: 2000 };
  save(metrics);

  assert.equal(h.reads.scrollTop, 0, "写前快照复用不能反向读取元素");
  assert.equal(h.reads.clientHeight, 0);
  assert.equal(h.reads.scrollHeight, 0);
  assert.deepEqual(cacheCalls, [metrics]);
  assert.deepEqual(saves, [{ key: "scope-a", state: metrics }]);
});

test("saveCurrentScrollMemory 无 metrics 时仍读取写后实时值", () => {
  const h = createMetricElement({ scrollTop: 400, clientHeight: 600, scrollHeight: 2000 });
  const saves: unknown[] = [];
  const save = bindCallback<() => void>("saveCurrentScrollMemory", {
    useCallback: (callback: unknown) => callback,
    scrollMemoryKey: "scope-a",
    scrollRef: { current: h.element },
    pendingDetachedScrollRestoreRef: { current: null },
    latestScrollMemoryStateRef: { current: null },
    cacheCurrentScrollMemoryState: (element: {
      scrollTop: number;
      clientHeight: number;
      scrollHeight: number;
    }) => ({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }),
    saveChatSessionScrollMemoryState: (_key: string, state: unknown) => saves.push(state),
  });

  save();

  assert.equal(h.reads.scrollTop, 1, "无快照时必须在调用点读取实时 scrollTop");
  assert.equal(h.reads.clientHeight, 1);
  assert.equal(h.reads.scrollHeight, 1);
  assert.deepEqual(saves, [{ scrollTop: 400, clientHeight: 600, scrollHeight: 2000 }]);
});

test("pending detached restore 仍优先于局部 metrics", () => {
  const h = createMetricElement({ scrollTop: 0, clientHeight: 600, scrollHeight: 0 });
  const pendingState = { scrollTop: 900, clientHeight: 600, scrollHeight: 2400, updatedAt: 1 };
  const saves: unknown[] = [];
  const cacheCalls: unknown[] = [];
  const save = bindCallback<(metrics?: unknown) => void>("saveCurrentScrollMemory", {
    useCallback: (callback: unknown) => callback,
    scrollMemoryKey: "scope-a",
    scrollRef: { current: h.element },
    pendingDetachedScrollRestoreRef: {
      current: { key: "scope-a", state: pendingState },
    },
    latestScrollMemoryStateRef: { current: null },
    cacheCurrentScrollMemoryState: (_element: unknown, metrics?: unknown) => {
      cacheCalls.push(metrics);
      return metrics ?? pendingState;
    },
    saveChatSessionScrollMemoryState: (_key: string, state: unknown) => saves.push(state),
  });

  save({ scrollTop: 0, viewportHeight: 600, contentHeight: 0 });

  assert.equal(h.reads.scrollTop, 0, "pending restore 优先时不得读取被钳制的空 DOM");
  assert.deepEqual(cacheCalls, []);
  assert.deepEqual(saves, [pendingState]);
});

test("cacheCurrentScrollMemoryState 接收 metrics 时不读取元素", () => {
  const h = createMetricElement({ scrollTop: 120, clientHeight: 600, scrollHeight: 2000 });
  const latestRef: { current: unknown } = { current: null };
  const builtFromMetrics: unknown[] = [];
  const cache = bindCallback<(element: unknown, metrics?: unknown) => unknown>(
    "cacheCurrentScrollMemoryState",
    {
      useCallback: (callback: unknown) => callback,
      scrollMemoryKey: "scope-a",
      latestScrollMemoryStateRef: latestRef,
      buildCurrentScrollMemoryState: (element: { scrollTop: number }) => ({
        scrollTop: element.scrollTop,
      }),
      buildCurrentScrollMemoryStateFromMetrics: (metrics: unknown) => {
        builtFromMetrics.push(metrics);
        return metrics;
      },
    },
  );

  const metrics = { scrollTop: 120, viewportHeight: 600, contentHeight: 2000 };
  const state = cache(h.element, metrics);

  assert.equal(h.reads.scrollTop, 0);
  assert.equal(h.reads.clientHeight, 0);
  assert.equal(h.reads.scrollHeight, 0);
  assert.deepEqual(builtFromMetrics, [metrics]);
  assert.deepEqual(latestRef.current, { key: "scope-a", state });
});

// ── handleScroll：连续同步片段复用，写入片段不复用 ─────────────────────────

function createHandleScrollHarness(overrides: Record<string, unknown> = {}) {
  const h = createMetricElement({ scrollTop: 100, clientHeight: 600, scrollHeight: 2000 });
  const saves: unknown[] = [];
  const followingCalls: boolean[] = [];
  const scrollRef = { current: h.element };
  const toggleAnchorRef: { current: unknown } = { current: null };
  const lastObservedScrollTopRef = { current: 0 };
  const layoutScrollGuardUntilRef = { current: 0 };
  const programmaticScrollFrameRef: { current: number | null } = { current: null };

  const bindings: Record<string, unknown> = {
    useCallback: (callback: unknown) => callback,
    scrollRef,
    getActiveUserScrollIntent: () => "none",
    toggleAnchorRef,
    shouldReleaseToggleAnchorOnUserScroll: () => false,
    touchClientYRef: { current: null },
    scrollbarPointerIdRef: { current: null },
    userScrollIntentRef: { current: { intent: "none", observedAt: 0 } },
    clearUserScrollAnchor: () => {},
    clearToggleAnchor: () => {},
    shouldCompensateTimelineToggleAnchorOnScroll: () => false,
    compensateToggleAnchor: () => false,
    programmaticScrollFrameRef,
    lastObservedScrollTopRef,
    layoutScrollGuardUntilRef,
    suppressVirtualizerAdjustmentDuringRestoreRef: { current: false },
    prependCommitGateRef: { current: { noteScroll: () => {} } },
    hasPendingOlder: false,
    setPrependReachedTop: () => {},
    isTimelineAtTop: () => false,
    refreshUserScrollAnchor: () => {},
    syncTurnNavigatorViewport: () => {},
    resolveFollowingAfterScroll: (
      input: { following: boolean; source: string; metrics: unknown },
      _unused?: unknown,
    ) => input.following,
    followingRef: { current: true },
    commitFollowing: (following: boolean) => followingCalls.push(following),
    pendingDetachedScrollRestoreRef: { current: null },
    userAdjustedScrollSinceRestoreRef: { current: false },
    saveCurrentScrollMemory: (metrics?: unknown) => saves.push(metrics),
    maybePrefetchOlder: () => {},
    maybePrefetchNewer: () => {},
    virtualizer: {},
    ...overrides,
  };

  const handleScroll = bindCallback<() => void>("handleScroll", bindings);

  return {
    h,
    saves,
    followingCalls,
    scrollRef,
    toggleAnchorRef,
    lastObservedScrollTopRef,
    layoutScrollGuardUntilRef,
    programmaticScrollFrameRef,
    run: handleScroll,
  };
}

test("handleScroll 用户连续同步片段复用同一组 metrics，且不写 DOM", () => {
  const harness = createHandleScrollHarness();
  harness.h.state.scrollTop = 250;

  harness.run();

  assert.deepEqual(
    harness.saves,
    [{ scrollTop: 250, viewportHeight: 600, contentHeight: 2000 }],
    "同一同步片段内没有写入，保存应复用已读 metrics，避免重复 getter",
  );
  assert.equal(harness.h.state.scrollTop, 250, "用户净位移不得被读取路径改写");
  assert.deepEqual(harness.h.scrollTopWrites, [], "读取路径不得写 scrollTop");
});

test("handleScroll 布局补偿写入后不把写前 metrics 交给保存", () => {
  const harness = createHandleScrollHarness({
    toggleAnchorRef: { current: { element: {}, offsetTop: 0, contentOffset: 0, startedAt: 0 } },
    shouldCompensateTimelineToggleAnchorOnScroll: () => true,
    compensateToggleAnchor: (element: { scrollTop: number }) => {
      // 复刻真实补偿：写入后 markLayoutScrollGuard，handleScroll 因此归类为 layout。
      element.scrollTop += 10;
      harness.layoutScrollGuardUntilRef.current = Date.now() + 250;
      return true;
    },
  });

  harness.run();

  assert.deepEqual(harness.h.scrollTopWrites, [110], "补偿确实发生了一次位置写入");
  assert.deepEqual(harness.saves, [], "写入片段不得复用写前快照保存记忆");
});

test("handleScroll 程序化滚动不保存用户记忆", () => {
  const harness = createHandleScrollHarness();
  harness.programmaticScrollFrameRef.current = 1;
  harness.lastObservedScrollTopRef.current = harness.h.state.scrollTop;

  harness.run();

  assert.deepEqual(harness.saves, []);
});

// ── 位置写入后仍读取写后值 ─────────────────────────────────────────────────

test("scrollToBottom 写入后按浏览器钳制后的落点保存记忆", () => {
  const h = createMetricElement({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 });
  // 浏览器会把 scrollTop 钳到 maxScrollTop = 1000 - 400 = 600。
  Object.defineProperty(h.element, "scrollTop", {
    get() {
      h.reads.scrollTop += 1;
      return h.state.scrollTop;
    },
    set(value: number) {
      h.scrollTopWrites.push(value);
      h.state.scrollTop = Math.min(value, h.state.scrollHeight - h.state.clientHeight);
    },
    configurable: true,
  });
  const cached: Array<{ scrollTop: number }> = [];
  let notified = 0;
  const scrollToBottom = bindCallback<(options?: { force?: boolean }) => void>("scrollToBottom", {
    useCallback: (callback: unknown) => callback,
    shouldSuppressTimelineScrollToBottom: () => false,
    toggleAnchorRef: { current: null },
    followSuspendedRef: { current: false },
    clearUserScrollAnchor: () => {},
    scrollRef: { current: h.element },
    markProgrammaticScroll: () => {},
    responsiveCenteredEmptyLayout: false,
    lastObservedScrollTopRef: { current: 0 },
    syncTurnNavigatorViewport: () => {},
    userAdjustedScrollSinceRestoreRef: { current: false },
    cacheCurrentScrollMemoryState: (element: { scrollTop: number }) =>
      cached.push({ scrollTop: element.scrollTop }),
    notifyScrollObserversAfterCommit: () => {
      notified += 1;
    },
  });

  scrollToBottom({ force: true });

  assert.deepEqual(h.scrollTopWrites, [1000], "贴底写入原始 scrollHeight");
  assert.deepEqual(cached, [{ scrollTop: 600 }], "写入后必须回读写后实际值，不能复用写前快照");
  assert.equal(notified, 1);
});

// ── 4.3 同批合成滚动通知合并 ───────────────────────────────────────────────

function createNotifyHarness() {
  const scheduled: Array<() => void> = [];
  let dispatches = 0;
  const makeElement = () => ({
    dispatchEvent: (_event: unknown) => {
      dispatches += 1;
      return true;
    },
  });
  const element = makeElement();
  const otherElement = makeElement();
  const scrollRef: { current: unknown } = { current: element };
  const scrollNotificationScopeRef = { current: "scope-a" };
  const pendingScrollNotificationRef: {
    current: { element: unknown; scope: string; token: number } | null;
  } = { current: null };
  const scrollNotificationTokenRef = { current: 0 };
  const notify = bindCallback<(element: unknown) => void>("notifyScrollObserversAfterCommit", {
    useCallback: (callback: unknown) => callback,
    scheduleMicrotask: (callback: () => void) => {
      scheduled.push(callback);
    },
    scrollRef,
    scrollNotificationScopeRef,
    pendingScrollNotificationRef,
    scrollNotificationTokenRef,
  });
  return {
    element,
    otherElement,
    scrollRef,
    scrollNotificationScopeRef,
    pendingScrollNotificationRef,
    scrollNotificationTokenRef,
    scheduled,
    get dispatches() {
      return dispatches;
    },
    notify,
    flush() {
      const batch = scheduled.splice(0);
      for (const callback of batch) callback();
    },
  };
}

test("flush 前同元素同作用域 N 次请求只派发一次，且只排一个 microtask", () => {
  const h = createNotifyHarness();

  h.notify(h.element);
  h.notify(h.element);
  h.notify(h.element);

  assert.equal(h.scheduled.length, 1, "同批请求必须共用一个 microtask 槽");
  h.flush();
  assert.equal(h.dispatches, 1);
});

test("同会话窗口代际更新不丢最终通知（windowEpoch 不参与失效判定）", () => {
  const h = createNotifyHarness();

  // 同一 scrollMemoryKey 下窗口行集/代际变化：没有真实作用域切换。
  h.notify(h.element);
  h.notify(h.element);

  h.flush();

  assert.equal(h.dispatches, 1, "同一真实会话的窗口更新仍需要一次最终合成通知");
});

test("真实作用域更换后旧通知失效，当前作用域正常派发", () => {
  const h = createNotifyHarness();

  h.notify(h.element);
  h.scrollNotificationScopeRef.current = "scope-b";
  h.flush();
  assert.equal(h.dispatches, 0, "旧作用域 pending 不得派发");

  h.notify(h.element);
  h.flush();
  assert.equal(h.dispatches, 1, "当前作用域仍须派发一次");
});

test("A→B→A 的旧请求不清除最终 A pending，最终只派发一次", () => {
  const h = createNotifyHarness();

  h.notify(h.element); // A
  h.scrollNotificationScopeRef.current = "scope-b";
  h.notify(h.element); // B
  h.scrollNotificationScopeRef.current = "scope-a";
  h.notify(h.element); // A 再次

  h.flush();

  assert.equal(h.dispatches, 1, "旧 token 既不派发也不能清掉最终的 A pending");
  assert.equal(h.pendingScrollNotificationRef.current, null, "派发后 pending 必须被消费");
});

test("旧回调用元素替换后不派发", () => {
  const h = createNotifyHarness();

  h.notify(h.element);
  h.scrollRef.current = h.otherElement;
  h.flush();

  assert.equal(h.dispatches, 0);
});

test("卸载失效后旧回调不派发，新元素请求仍可派发", () => {
  const h = createNotifyHarness();

  h.notify(h.element);
  // 复刻卸载 cleanup：清 pending 并推进 token。
  h.pendingScrollNotificationRef.current = null;
  h.scrollNotificationTokenRef.current += 1;
  h.flush();
  assert.equal(h.dispatches, 0);

  h.notify(h.otherElement);
  h.scrollRef.current = h.otherElement;
  h.flush();
  assert.equal(h.dispatches, 1);
});

test("一次 flush 后可再次请求并再次派发", () => {
  const h = createNotifyHarness();

  h.notify(h.element);
  h.flush();
  h.notify(h.element);
  h.flush();

  assert.equal(h.dispatches, 2, "每次新的 pending 周期各派发一次");
});

test("合成通知仍通过 dispatchEvent 同步派发，监听者读取最终真实位置", () => {
  const h = createNotifyHarness();
  const observed: number[] = [];
  let scrollTop = 0;
  h.element.dispatchEvent = () => {
    observed.push(scrollTop);
    return true;
  };

  h.notify(h.element);
  scrollTop = 320;
  h.flush();

  assert.deepEqual(observed, [320], "派发时不得使用排队时的旧位置");
});

test("通知作用域只在 layout effect（commit）中推进，render 阶段不写 ref", () => {
  const assignments: Array<{ inLayoutEffect: boolean }> = [];
  const visit = (node: ts.Node, layoutEffectDepth: number) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useLayoutEffect" &&
      node.arguments[0]
    ) {
      ts.forEachChild(node.arguments[0], (child) => visit(child, layoutEffectDepth + 1));
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === "scrollNotificationScopeRef.current"
    ) {
      assignments.push({ inLayoutEffect: layoutEffectDepth > 0 });
    }
    ts.forEachChild(node, (child) => visit(child, layoutEffectDepth));
  };
  visit(source, 0);

  assert.equal(assignments.length, 1, "scope ref 只应有一个提交阶段写入点");
  assert.equal(
    assignments[0]?.inLayoutEffect,
    true,
    "render 阶段写入会被并发渲染中已放弃的分支污染，进而吞掉已提交的 pending 通知",
  );
});

test("scope commit effect 声明在所有 notify 调用之前，同一 commit 内先推进再派发", () => {
  const effectStart = findScopeCommitEffect().getStart(source);
  const callSites: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "notifyScrollObserversAfterCommit"
    ) {
      callSites.push(node.getStart(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  assert.ok(callSites.length >= 4, "应覆盖所有提交后的合成通知入口");
  for (const callSite of callSites) {
    assert.ok(effectStart < callSite, "必须先把 scope 推进到提交值，再允许同 commit 的 notify");
  }
});

test("提交前不改变通知作用域：未提交的 render 意图不会吞掉已提交通知", () => {
  const h = createNotifyHarness();
  // 未提交的 render 只产生切换意图，不调用 scope commit effect。
  h.notify(h.element);
  h.flush();
  assert.equal(h.dispatches, 1, "已提交作用域的通知必须派发");

  // 真正提交后才推进作用域，后续请求绑定新作用域。
  const commitScopeB = bindScopeCommit(h.scrollNotificationScopeRef, "scope-b", "session-a");
  commitScopeB();
  assert.equal(h.scrollNotificationScopeRef.current, "scope-b");

  h.notify(h.element);
  h.flush();
  assert.equal(h.dispatches, 2, "提交后新作用域的请求正常派发");
});

// ── 首绘 staging 测量回调回归（保持一次就位与无依赖 layout effect） ─────────

interface StagedHeightIdentity {
  sessionKey: string;
  windowEpoch: number;
  heightPx: number;
}

function stagedChild(turnKey: string | null, height: number) {
  const node = {
    height,
    getAttribute: (name: string) => (name === "data-staged-turn-key" ? turnKey : null),
    getBoundingClientRect: () => ({ height: node.height }),
  };
  return node;
}

function createStagingHarness(input: {
  children: Array<ReturnType<typeof stagedChild>>;
  viewportHeight: number;
  viewportHeightRef?: number;
  container?: { children: unknown[] } | null;
  stagedHeight?: StagedHeightIdentity | null;
  sessionKey?: string;
  windowEpoch?: number;
}) {
  const viewportSets: number[] = [];
  const stagedSets: StagedHeightIdentity[] = [];
  const heightCache = new Map<string, number>();
  const scrollRef = { current: { clientHeight: input.viewportHeight } };
  const firstPaintViewportHeightPxRef = {
    current: input.viewportHeightRef ?? input.viewportHeight,
  };
  const firstPaintStagedHeightRef: { current: StagedHeightIdentity | null } = {
    current: input.stagedHeight ?? null,
  };
  const bindings: Record<string, unknown> = {
    stagingActive: true,
    scrollRef,
    firstPaintViewportHeightPxRef,
    setFirstPaintViewportHeightPx: (value: number) => viewportSets.push(value),
    firstPaintStagingRef: {
      current: input.container === undefined ? { children: input.children } : input.container,
    },
    heightCacheRef: {
      current: {
        set: (key: string, height: number) => heightCache.set(key, height),
      },
    },
    firstPaintStagedHeightRef,
    sessionKeyRef: { current: input.sessionKey ?? "session-a" },
    windowEpochRef: { current: input.windowEpoch ?? 1 },
    setFirstPaintStagedHeight: (value: StagedHeightIdentity) => stagedSets.push(value),
  };
  const call = findLayoutEffectCall("data-staged-turn-key");
  assert.equal(
    call.arguments.length,
    1,
    "首绘测量必须保持无依赖 layout effect：每次 commit 都按当前 DOM 重测",
  );
  const run = evaluateExpression<() => void>(call.arguments[0], bindings);
  return {
    run,
    viewportSets,
    stagedSets,
    heightCache,
    scrollRef,
    firstPaintViewportHeightPxRef,
    firstPaintStagedHeightRef,
  };
}

test("首绘测量把每一轮非零实测高度写入缓存，零高度被拒", () => {
  const harness = createStagingHarness({
    children: [stagedChild("turn-a", 120.4), stagedChild("turn-b", 0), stagedChild(null, 40)],
    viewportHeight: 600,
    viewportHeightRef: 600,
    stagedHeight: { sessionKey: "session-a", windowEpoch: 1, heightPx: 160 },
  });

  harness.run();

  assert.equal(harness.heightCache.get("turn-a"), 120, "高度必须四舍五入后写缓存");
  assert.equal(harness.heightCache.has("turn-b"), false, "零高度不得污染缓存");
  assert.equal(harness.heightCache.size, 1);
});

test("首绘测量同值不调用 setter，值变化才更新", () => {
  const children = [stagedChild("turn-a", 120)];
  const harness = createStagingHarness({
    children,
    viewportHeight: 600,
    viewportHeightRef: 600,
    stagedHeight: { sessionKey: "session-a", windowEpoch: 1, heightPx: 120 },
  });

  harness.run();
  assert.deepEqual(harness.viewportSets, [], "视口高度未变时不得调用 setter");
  assert.deepEqual(harness.stagedSets, [], "高度未变时不得调用 setter");

  // 同一批 DOM 高度变化 → 更新一次。
  children[0].height = 220;
  harness.run();
  assert.deepEqual(harness.stagedSets, [
    { sessionKey: "session-a", windowEpoch: 1, heightPx: 220 },
  ]);

  // 值不变再次运行：不重复 setter（避免无依赖 effect 的嵌套更新）。
  harness.run();
  assert.equal(harness.stagedSets.length, 1);
});

test("首绘测量身份不匹配时即使高度相同也重新记账", () => {
  for (const [sessionKey, windowEpoch] of [
    ["session-old", 1],
    ["session-a", 0],
  ] as const) {
    const harness = createStagingHarness({
      children: [stagedChild("turn-a", 120)],
      viewportHeight: 600,
      viewportHeightRef: 600,
      sessionKey: "session-a",
      windowEpoch: 1,
      stagedHeight: { sessionKey, windowEpoch, heightPx: 120 },
    });

    harness.run();

    assert.deepEqual(
      harness.stagedSets,
      [{ sessionKey: "session-a", windowEpoch: 1, heightPx: 120 }],
      `身份 ${sessionKey}/${windowEpoch} 不匹配时必须按当前身份重写`,
    );
  }
});

test("首绘测量先同步视口高度，再因暗处容器缺席而返回", () => {
  const harness = createStagingHarness({
    children: [],
    viewportHeight: 720,
    viewportHeightRef: 0,
    container: null,
  });

  harness.run();

  assert.deepEqual(
    harness.viewportSets,
    [720],
    "容器还没挂上时也必须先同步视口高度，不能用 0 当作补齐尺子",
  );
  assert.deepEqual(harness.stagedSets, [], "容器缺席时没有可测量的轮，不得记高度");
});

test("首绘测量容器缺席不影响已有高度，视口变化仍单独入账", () => {
  const harness = createStagingHarness({
    children: [],
    viewportHeight: 500,
    viewportHeightRef: 720,
    container: null,
    stagedHeight: { sessionKey: "session-a", windowEpoch: 1, heightPx: 300 },
  });

  harness.run();

  assert.deepEqual(harness.viewportSets, [500]);
  assert.deepEqual(harness.stagedSets, [], "没有新测量结果时不得覆盖已有高度");
});
