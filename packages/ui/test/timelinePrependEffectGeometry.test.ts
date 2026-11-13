import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { prependScrollAdjustment } from "../src/v4/timelineScrollAnchor.js";

// 回归目标：prepend useLayoutEffect 在「没有真实前插」的提交里，不得为诊断读取
// 滚动容器的几何值。这里直接提取组件里的真实 effect 回调并执行，而不是断言源码
// 字符串，也不是复制一份补偿算法。
//
// red（修复前）：无 prepend / 待恢复接管两条路径都会先读一次 scrollTop，只为拼装
// 诊断事件。green（修复后）：两条路径的几何 getter 调用为 0；真实前插的有符号差值、
// 块 + inset 单笔补偿、用户滚动权与会话切换基线仍然保持。

const source = ts.createSourceFile(
  "ConversationTimeline.tsx",
  await readFile(new URL("../src/v4/ConversationTimeline.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

/** 提取包含全部标记的 useLayoutEffect 回调（prepend 锚定效应）。 */
function extractLayoutEffectCallback(markers: readonly string[]): string {
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useLayoutEffect" &&
      node.arguments.length === 1
    ) {
      const text = node.arguments[0].getText(source);
      if (markers.every((marker) => text.includes(marker))) {
        callback = node.arguments[0];
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback, `找不到 prepend useLayoutEffect 回调: ${markers.join(", ")}`);
  const { outputText } = ts.transpileModule(`const callback = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return outputText;
}

const PREPEND_EFFECT = extractLayoutEffectCallback([
  "const prev = prependAnchorRef.current",
  "const didPrepend",
  "prependAnchorRef.current = {",
]);

type LayoutEffect = () => void;

interface HarnessOptions {
  initialMount?: boolean;
  prevFirstRowId?: number | null;
  prevTotalSize?: number;
  nextFirstRowId?: number | null;
  nextTotalSize?: number;
  pendingRestoreKey?: string | null;
  scrollMemoryKey?: string;
  blockCommitInFlight?: boolean;
  blockHeightPx?: number | null;
  headerSlotHeight?: number;
  topInsetPx?: number;
  appliedTopInsetPx?: number;
  userInteraction?: boolean;
  userAnchorVisibleAfterRefresh?: boolean;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const {
    initialMount = false,
    prevFirstRowId = 100,
    prevTotalSize = 1000,
    nextFirstRowId = 100,
    nextTotalSize = 1000,
    pendingRestoreKey = null,
    scrollMemoryKey = "session-a",
    blockCommitInFlight = false,
    blockHeightPx = null,
    headerSlotHeight = 0,
    topInsetPx = 0,
    appliedTopInsetPx = 0,
    userInteraction = false,
    userAnchorVisibleAfterRefresh = true,
    scrollTop = 0,
    scrollHeight = 5000,
    clientHeight = 600,
  } = options;

  const state = { scrollTop, scrollHeight, clientHeight };
  const reads = { scrollTop: 0, scrollHeight: 0, clientHeight: 0, rect: 0 };
  const writes: number[] = [];
  const element = {
    get scrollTop() {
      reads.scrollTop += 1;
      return state.scrollTop;
    },
    set scrollTop(value: number) {
      writes.push(value);
      state.scrollTop = value;
    },
    get scrollHeight() {
      reads.scrollHeight += 1;
      return state.scrollHeight;
    },
    get clientHeight() {
      reads.clientHeight += 1;
      return state.clientHeight;
    },
    getBoundingClientRect() {
      reads.rect += 1;
      return { height: state.scrollHeight } as DOMRect;
    },
  };
  const blockElement = {
    getBoundingClientRect() {
      reads.rect += 1;
      return { height: blockHeightPx ?? 0 } as DOMRect;
    },
  };

  const calls = { guard: 0, sync: 0, cache: 0, notify: 0, refresh: 0, clear: 0 };
  const prependAnchorRef = { current: { firstRowId: prevFirstRowId, totalSize: prevTotalSize } };
  const initialMountCommitRef = { current: initialMount };
  const lastObservedScrollTopRef = { current: state.scrollTop };
  const pendingUserScrollAnchorCorrectionRef = { current: false };
  const userScrollAnchorRef = { current: null as { key: string; start: number } | null };
  const settleTopInsetRef = { current: appliedTopInsetPx };

  const bindings: Record<string, unknown> = {
    prependAnchorRef,
    rowsRef: {
      current: nextFirstRowId === null ? [] : [{ rowId: nextFirstRowId }],
    },
    virtualizer: { getTotalSize: () => nextTotalSize },
    initialMountCommitRef,
    pendingDetachedScrollRestoreRef: {
      current: pendingRestoreKey === null ? null : { key: pendingRestoreKey },
    },
    scrollMemoryKey,
    blockCommitInFlightRef: { current: blockCommitInFlight },
    prependScrollAdjustment,
    prependBlocksRef: { current: blockHeightPx === null ? null : blockElement },
    headerSlotHeight,
    PENDING_HISTORY_SLOT_PX: 56,
    topInsetPx,
    settleTopInset: (nextInset: number) => {
      const adjustment = nextInset - settleTopInsetRef.current;
      settleTopInsetRef.current = nextInset;
      return adjustment;
    },
    scrollRef: { current: element },
    markLayoutScrollGuard: () => {
      calls.guard += 1;
    },
    lastObservedScrollTopRef,
    syncTurnNavigatorViewport: () => {
      calls.sync += 1;
    },
    cacheCurrentScrollMemoryState: () => {
      calls.cache += 1;
    },
    notifyScrollObserversAfterCommit: () => {
      calls.notify += 1;
    },
    pendingUserScrollAnchorCorrectionRef,
    userScrollAnchorRef,
    hasActiveUserScrollInteraction: () => userInteraction,
    refreshUserScrollAnchor: () => {
      calls.refresh += 1;
      if (userAnchorVisibleAfterRefresh) {
        userScrollAnchorRef.current = { key: "turn-a", start: 100 };
      }
    },
    clearUserScrollAnchor: () => {
      calls.clear += 1;
      userScrollAnchorRef.current = null;
    },
    // 修复前 effect 里仍存在的临时诊断绑定：保留为无副作用替身，让同一份测试
    // 既能在未修复基线上跑红，也能在修复后跑绿。
    recordConversationTimelineDebugEvent: () => {},
    TIMELINE_SCROLL_DEBUG_RUN_ID: "test-run",
    pendingPrependDebugRequestIdRef: { current: null },
    pendingPrependDebugLoadingObservedRef: { current: null },
    lastPrependDebugContextRef: { current: null },
    PREPEND_DEBUG_CONTEXT_TTL_MS: 1000,
    clearPendingPrependDebugTimer: () => {},
  };

  const callback = new Function(...Object.keys(bindings), `${PREPEND_EFFECT}\nreturn callback;`)(
    ...Object.values(bindings),
  ) as LayoutEffect;

  return {
    run: callback,
    state,
    reads,
    writes,
    calls,
    prependAnchorRef,
    initialMountCommitRef,
    lastObservedScrollTopRef,
    pendingUserScrollAnchorCorrectionRef,
    userScrollAnchorRef,
    settleTopInsetRef,
    geometryReads() {
      return reads.scrollTop + reads.scrollHeight + reads.clientHeight + reads.rect;
    },
  };
}

test("初始挂载帧不读几何、不写 scrollTop，只对齐基线", () => {
  const h = createHarness({
    initialMount: true,
    prevFirstRowId: null,
    nextFirstRowId: 10,
    nextTotalSize: 720,
  });
  h.run();
  assert.equal(h.geometryReads(), 0, "初始挂载不依赖容器几何");
  assert.equal(h.writes.length, 0);
  assert.equal(h.initialMountCommitRef.current, false);
  assert.deepEqual(h.prependAnchorRef.current, { firstRowId: 10, totalSize: 720 });
});

test("无 prepend 的提交不读取 scrollTop，也不写补偿", () => {
  // 同一首行、总高度变化（流式测高）不是前插；此处曾为诊断读取 scrollTop。
  const h = createHarness({ prevFirstRowId: 100, nextFirstRowId: 100, nextTotalSize: 1400 });
  h.run();
  assert.equal(h.reads.scrollTop, 0, "无 prepend 路径不得读取 scrollTop");
  assert.equal(h.geometryReads(), 0, "无 prepend 路径不得触发任何几何 getter");
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.notify, 0);
  assert.deepEqual(h.prependAnchorRef.current, { firstRowId: 100, totalSize: 1400 });
});

test("真实前插的正差值单笔补偿 scrollTop", () => {
  const h = createHarness({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    prevTotalSize: 1000,
    nextTotalSize: 1600,
    userInteraction: true,
  });
  h.run();
  assert.deepEqual(h.writes, [600]);
  assert.equal(h.state.scrollTop, 600);
  assert.equal(h.calls.guard, 1);
  assert.equal(h.calls.notify, 1, "提交后补发一次合成 scroll 通知");
  assert.equal(h.calls.refresh, 1, "用户滚动交互期间重新锚定用户锚点");
  assert.equal(h.calls.clear, 0);
});

test("真实前插的负差值保持有符号，不被钳成零", () => {
  const h = createHarness({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    prevTotalSize: 1600,
    nextTotalSize: 1000,
  });
  h.run();
  assert.deepEqual(h.writes, [-600]);
  assert.equal(h.state.scrollTop, -600);
});

test("首行变化但总高度不变（零差值）仍按一次补偿路径结算", () => {
  const h = createHarness({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    prevTotalSize: 1000,
    nextTotalSize: 1000,
  });
  h.run();
  assert.equal(h.writes.length, 1, "差值 0 也要走同一笔写入以结算 inset");
  assert.equal(h.writes[0], 0);
});

test("块提交与 inset 合并为一笔写入", () => {
  // 窗口首轮被块收编：有符号差值为负（-600），块容器终值 900、header 10、占位块 56。
  // 旧 appliedTopInset=56（占位块还在时），提交帧 inset 结到 966，差 +910。
  const h = createHarness({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    prevTotalSize: 1600,
    nextTotalSize: 1000,
    blockCommitInFlight: true,
    blockHeightPx: 900,
    headerSlotHeight: 10,
    topInsetPx: 56,
    appliedTopInsetPx: 56,
  });
  h.run();
  assert.equal(h.reads.rect, 1, "块容器终值只需一次实测");
  assert.deepEqual(h.writes, [310], "有符号差值 -600 与 inset +910 合成一笔");
  assert.equal(h.state.scrollTop, 310);
  assert.equal(h.settleTopInsetRef.current, 966);
});

test("待恢复的离底记忆拥有坐标系：前插不写、不读诊断几何", () => {
  const h = createHarness({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    prevTotalSize: 1000,
    nextTotalSize: 1600,
    pendingRestoreKey: "session-a",
    scrollMemoryKey: "session-a",
  });
  h.run();
  assert.equal(h.reads.scrollTop, 0, "恢复接管时不得先读诊断 scrollTop");
  assert.equal(h.geometryReads(), 0);
  assert.equal(h.writes.length, 0, "恢复 effect 会在同一 commit 重放原始位置");
  assert.equal(h.calls.clear, 1, "前插结束用户测高校正所有权");
  assert.deepEqual(h.prependAnchorRef.current, { firstRowId: 100, totalSize: 1600 });
});

test("没有活跃用户滚动时前插后清理锚点，不重新锚定", () => {
  const h = createHarness({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    nextTotalSize: 1600,
    userInteraction: false,
  });
  h.run();
  assert.equal(h.calls.refresh, 0);
  assert.equal(h.calls.clear, 1);
});

test("会话切换后基线归零，跨会话 rowId 不被误判为前插", () => {
  // 会话切换 effect 会把 prependAnchorRef 重置为 {null, 0}；这里验证随后首次提交
  // 只对齐基线，不因新会话首行更小而补一笔 scrollTop。
  const h = createHarness({
    prevFirstRowId: null,
    prevTotalSize: 0,
    nextFirstRowId: 999,
    nextTotalSize: 2500,
  });
  h.run();
  assert.equal(h.writes.length, 0);
  assert.equal(h.geometryReads(), 0);
  assert.deepEqual(h.prependAnchorRef.current, { firstRowId: 999, totalSize: 2500 });
});
