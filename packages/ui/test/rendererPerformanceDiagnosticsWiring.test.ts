import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  ConversationSnapshot,
  ConversationTopicFrame,
  SessionSummary,
  SessionsIndexTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import {
  startRendererPerformanceDiagnostics,
  type RendererPerformanceDiagnosticsHandle,
  type RendererPerformanceScheduler,
  type RendererPerformanceSummaryV1,
} from "../src/lib/rendererPerformanceDiagnostics.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import type { ConversationTransport } from "@/v4/transport.js";
import type { SessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";

// 接线断言（docs/specs/renderer-performance-diagnostics.md）：
// - store 的 handleFrame 必须整帧包一层 measure，且同步主体原样保留；
// - 聚合 hook / SessionPane / Timeline 必须在固定 stage 上计时，workUnits 口径固定；
// - React Profiler 仅 Vite DEV 构建包住 SessionPane 内部渲染子树，生产不透传 Profiler。
// 真实 store 帧路径用注入 clock/writer 的诊断实例验证，不依赖 DOM 或运行中的 YCode。

// 工作区部分文件是 CRLF 检出，源码断言前统一换行，避免锚点因行尾差异失效。
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const sessionPaneSource = readSource("../src/v4/SessionPane.tsx");
const timelineSource = readSource("../src/v4/ConversationTimeline.tsx");
const projectionStoreSource = readSource("../src/v4/conversationProjectionStore.ts");
const sessionsIndexStoreSource = readSource("../src/v4/sessionsIndexStore.ts");
const sessionsItemsHookSource = readSource("../src/v4/useWorkspaceSessionsIndexItems.ts");

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  for (let index = source.indexOf(needle); index !== -1; index = source.indexOf(needle, index + needle.length)) {
    count += 1;
  }
  return count;
}

function sliceBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `找不到锚点：${startAnchor}`);
  const end = source.indexOf(endAnchor, start);
  assert.notEqual(end, -1, `找不到锚点：${endAnchor}`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// 源码接线：stage 与 workUnits 口径
// ---------------------------------------------------------------------------

test("conversation.frame：整个 handleFrame 同步执行被 measure 包裹，原守卫与主体不变", () => {
  assert.equal(countOccurrences(projectionStoreSource, '"conversation.frame"'), 1);
  assert.match(
    projectionStoreSource,
    /measureRendererPerformance\("conversation\.frame", \(\) => \{\s*this\.handleFrameSync\(frame, delivery\);\s*\}\);/,
    "handleFrame 必须只加薄 wrapper 调用私有同步主体，且不传 workUnits",
  );
  const wrapperStart = projectionStoreSource.indexOf('measureRendererPerformance("conversation.frame"');
  const innerSignature = projectionStoreSource.indexOf("private handleFrameSync(");
  const closedGuard = projectionStoreSource.indexOf("if (this.closed) return;", innerSignature);
  assert.ok(wrapperStart < innerSignature, "wrapper 必须在私有主体之前");
  assert.ok(innerSignature < closedGuard, "closed 守卫必须留在同步主体内");
  // 订阅代际守卫（旧订阅迟到帧丢弃）同样必须保留在同步主体中。
  assert.ok(
    projectionStoreSource.indexOf("frame.subscriptionId !== this.state.subscriptionId", innerSignature) >
      innerSignature,
    "subscriptionId 代际守卫必须保留",
  );
});

test("sessions-index.frame：整帧同步处理被 measure 包裹，且不传 workUnits", () => {
  assert.equal(countOccurrences(sessionsIndexStoreSource, '"sessions-index.frame"'), 1);
  assert.match(
    sessionsIndexStoreSource,
    /measureRendererPerformance\("sessions-index\.frame", \(\) => \{\s*this\.handleFrameSync\(frame, delivery\);\s*\}\);/,
  );
  const innerSignature = sessionsIndexStoreSource.indexOf("private handleFrameSync(");
  assert.notEqual(innerSignature, -1);
  assert.ok(
    sessionsIndexStoreSource.indexOf("this.subscriptionId === null", innerSignature) > innerSignature,
    "own-subscription 过滤必须保留在同步主体内",
  );
});

test("sessions-index.items：聚合 memo 用 record 收尾，workUnits = 输出 metas 数", () => {
  assert.equal(countOccurrences(sessionsItemsHookSource, '"sessions-index.items"'), 1);
  assert.equal(
    countOccurrences(sessionsItemsHookSource, "recordRendererPerformanceDuration("),
    1,
    "同一 memo 只能记录一次，避免与 measure 双计",
  );
  const recordStart = sessionsItemsHookSource.indexOf('recordRendererPerformanceDuration(\n      "sessions-index.items"');
  assert.notEqual(recordStart, -1);
  const recordCall = sliceBetween(
    sessionsItemsHookSource,
    '"sessions-index.items"',
    "return result;",
  );
  assert.match(recordCall, /items\.length/, "workUnits 必须固定为聚合输出 metas 数");
  assert.ok(
    sessionsItemsHookSource.indexOf("const startedAt = diagnosticsNow();") <
      sessionsItemsHookSource.indexOf("const metas: ZCodeTaskMeta[] = [];"),
    "计时起点必须在全表构造之前",
  );
  assert.ok(
    sessionsItemsHookSource.indexOf("stabilizeTaskListItems(") < recordStart,
    "稳定化必须仍在计时区间内",
  );
  assert.ok(
    sessionsItemsHookSource.includes("}, [signature, subscriptionSet, tick]);"),
    "memo 依赖必须保持原样",
  );
});

test("conversation.share-units：SessionPane 分享 units 构建计时，workUnits = rows.length", () => {
  assert.equal(countOccurrences(sessionPaneSource, '"conversation.share-units"'), 1);
  assert.match(
    sessionPaneSource,
    /measureRendererPerformance\(\s*"conversation\.share-units",\s*\(\) => buildConversationTurnRenderUnits\(snapshot\?\.rows\.window \?\? \[\]\),\s*snapshot\?\.rows\.window\.length \?\? 0,\s*\)/,
  );
  assert.ok(
    sessionPaneSource.includes("[snapshot?.rows.window],"),
    "shareRenderUnits memo 依赖必须保持原样",
  );
});

test("conversation.turn-frame：仅主时间线帧构建计时，workUnits = rows.length", () => {
  assert.equal(countOccurrences(timelineSource, '"conversation.turn-frame"'), 1);
  assert.match(
    timelineSource,
    /measureRendererPerformance\(\s*"conversation\.turn-frame",\s*\(\) =>\s*buildConversationTurnRenderUnitFrame\(rows, \{/,
  );
  const memo = sliceBetween(timelineSource, 'const renderUnits = useMemo(() => {', "}, [liveNowMs, rows, sessionPhase, windowConnectedToTail]);");
  assert.match(memo, /rows\.length/, "workUnits 必须是输入 rows 数");
  assert.ok(
    memo.indexOf("previousUnitFrameRef.current = frame;") > memo.indexOf("measureRendererPerformance("),
    "previousFrame 必须在测量后写入，保持原帧链",
  );
  assert.ok(
    timelineSource.includes("}, [liveNowMs, rows, sessionPhase, windowConnectedToTail]);"),
    "主帧 memo 依赖必须保持原样",
  );
});

// ---------------------------------------------------------------------------
// DEV React Profiler guard
// ---------------------------------------------------------------------------

test("react.session-pane：Profiler 仅在 Vite DEV 包住 SessionPane 内部子树", () => {
  assert.equal(countOccurrences(sessionPaneSource, "<Profiler "), 1);
  assert.match(
    sessionPaneSource,
    /function isSessionPaneProfilerEnabled\(\): boolean \{\s*return \(import\.meta as ImportMeta & \{ env\?: \{ readonly DEV\?: boolean \} \}\)\.env\?\.DEV === true;/,
    "DEV 判定必须读取 Vite 的 import.meta.env.DEV",
  );
  const profilerBlock = sliceBetween(
    sessionPaneSource,
    "function SessionPaneRenderProfiler(",
    "\n}\n",
  );
  assert.match(
    profilerBlock,
    /if \(!isSessionPaneProfilerEnabled\(\)\) return <>\{children\}<\/>;/,
    "生产（DEV=false）必须直接透传 children，不创建 Profiler",
  );
  assert.match(
    profilerBlock,
    /<Profiler id=\{SESSION_PANE_PROFILER_ID\} onRender=\{handleSessionPaneProfilerRender\}>/,
    "Profiler 必须使用固定 id",
  );
  assert.ok(sessionPaneSource.includes('const SESSION_PANE_PROFILER_ID = "session-pane";'));
  assert.equal(countOccurrences(sessionPaneSource, 'recordRendererPerformanceDuration("react.session-pane", actualDuration)'), 1);
  const onRenderBlock = sliceBetween(
    sessionPaneSource,
    "const handleSessionPaneProfilerRender: ProfilerOnRenderCallback = (",
    "};",
  );
  for (const forbidden of ["sessionId", "sessionKey", "workspacePath", "workspaceIdentity", "paneId"]) {
    assert.equal(
      onRenderBlock.includes(forbidden),
      false,
      `Profiler onRender 不得携带 ${forbidden}`,
    );
  }
  // 包的是组件内部渲染子树：paneRoot 仍是原来的 session pane 根节点。
  assert.ok(
    sessionPaneSource.includes("return <SessionPaneRenderProfiler>{paneRoot}</SessionPaneRenderProfiler>;"),
  );
  assert.ok(
    sessionPaneSource.includes("const paneRoot = (\n    <div\n      data-testid={testId(TID_V4_SESSION_PANE, paneId)}"),
    "Profiler 不得替换或改写 pane 根节点属性",
  );
  assert.ok(sessionPaneSource.includes("export function SessionPane({\n  paneId,"));
  assert.ok(sessionPaneSource.includes("}: SessionPaneProps) {"));
});

// ---------------------------------------------------------------------------
// 真实 store 帧路径（诊断通过注入依赖启动）
// ---------------------------------------------------------------------------

interface DiagnosticsHarness {
  handle: RendererPerformanceDiagnosticsHandle;
  summaries: RendererPerformanceSummaryV1[];
}

function startDiagnostics(options?: { visible?: boolean }): DiagnosticsHarness {
  const summaries: RendererPerformanceSummaryV1[] = [];
  const noopScheduler: RendererPerformanceScheduler = {
    setInterval: () => undefined,
    clearInterval: () => {},
  };
  const handle = startRendererPerformanceDiagnostics({
    windowMs: 60_000,
    scheduler: noopScheduler,
    observerFactory: () => null,
    visibility: {
      isVisible: () => options?.visible ?? true,
      isFocused: () => options?.visible ?? true,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    write: (summary) => {
      summaries.push(summary);
    },
  });
  return { handle, summaries };
}

function stageCount(summary: RendererPerformanceSummaryV1, stage: string): number {
  return (summary.stages as Record<string, { count: number } | undefined>)[stage]?.count ?? 0;
}

function stageWorkUnits(
  summary: RendererPerformanceSummaryV1,
  stage: string,
): { sum?: number; max?: number } {
  const metrics = (summary.stages as Record<string, { workUnitsSum?: number; workUnitsMax?: number }>)[
    stage
  ];
  return { sum: metrics?.workUnitsSum, max: metrics?.workUnitsMax };
}

const SESSION_ID = "sess-renderer-perf-wiring";
const TOPIC = conversationTopic(SESSION_ID);

function conversationSnapshot(seq: number): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    logEpoch: "epoch-1",
    seq,
    revision: 1,
    sandbox: { revision: 1, alive: null },
    rows: { window: [], totalCount: 0, firstRowId: null },
    queue: { items: [] },
    modelTransition: null,
  } as unknown as ConversationSnapshot;
}

function conversationSnapshotFrame(seq: number): ConversationTopicFrame {
  return {
    topic: TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: seq,
    sentAt: 1_000,
    payload: { kind: "snapshot", snapshot: conversationSnapshot(seq) },
  } as unknown as ConversationTopicFrame;
}

async function createConversationStore(): Promise<ConversationProjectionStore> {
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: "sub-1", logEpoch: "epoch-1", mode: "snapshot" },
    }),
    activate: () => {},
    unsubscribe: async () => {},
    resync: async () => ({ frames: [] }),
    rowsRange: async () => ({ rows: [], atSeq: 1, atRevision: 1, atLogEpoch: "epoch-1" }),
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport;
  const store = new ConversationProjectionStore(TOPIC, transport);
  await store.connect();
  return store;
}

const WORKSPACE_ID = "workspace-perf-wiring";
const SESSIONS_INDEX_TOPIC = `sessions-index/${WORKSPACE_ID}`;

function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    workspaceId: WORKSPACE_ID,
    title: "任务",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function sessionsIndexSnapshotFrame(seq: number): SessionsIndexTopicFrame {
  return {
    topic: SESSIONS_INDEX_TOPIC,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: seq,
    sentAt: seq,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: WORKSPACE_ID,
        logEpoch: "epoch-1",
        sessions: [sessionSummary()],
      },
    },
  } as unknown as SessionsIndexTopicFrame;
}

async function createSessionsIndexStore(): Promise<{
  store: SessionsIndexStore;
  deliver: (frame: SessionsIndexTopicFrame) => void;
}> {
  let frameHandler:
    | ((frame: SessionsIndexTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void)
    | null = null;
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: "sub-1", logEpoch: "epoch-1", mode: "snapshot" },
    }),
    activate: () => {},
    unsubscribe: async () => {},
    resync: async () => ({ ack: { subscriptionId: "sub-1", mode: "resume" } }),
    onFrame: (
      handler: (frame: SessionsIndexTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void,
    ) => {
      frameHandler = handler;
      return () => {};
    },
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as SessionsIndexTransport;
  const store = new SessionsIndexStore();
  await store.connect(transport);
  return {
    store,
    deliver: (frame) => {
      const handler = frameHandler;
      assert.ok(handler, "sessions-index transport 必须注册帧监听");
      handler(frame, { deliveryKind: "initial" });
    },
  };
}

test("conversation.frame 在真实 handleFrame 路径记录且不带 workUnits", async () => {
  const diagnostics = startDiagnostics();
  try {
    const store = await createConversationStore();
    store.handleFrame(conversationSnapshotFrame(3));

    // 旧行为保持：快照仍然整替换并推进 seq。
    assert.equal(store.getState().snapshot?.seq, 3);
    assert.equal(store.getState().status, "live");

    diagnostics.handle.flush();
    const summary = diagnostics.summaries.at(-1);
    assert.ok(summary, "有活动的窗口必须写出 summary");
    assert.equal(stageCount(summary, "conversation.frame"), 1);
    assert.deepEqual(
      stageWorkUnits(summary, "conversation.frame"),
      { sum: undefined, max: undefined },
      "conversation.frame 不得携带 workUnits",
    );
  } finally {
    diagnostics.handle.stop();
  }
});

test("conversation.frame 在不可见时不改变 store 应用结果", async () => {
  const diagnostics = startDiagnostics({ visible: false });
  try {
    const store = await createConversationStore();
    store.handleFrame(conversationSnapshotFrame(5));
    assert.equal(store.getState().snapshot?.seq, 5);
    assert.equal(store.getState().status, "live");
    // 可见性只影响 rAF/timer 采样，不影响 stage 计时。
    diagnostics.handle.flush();
    const summary = diagnostics.summaries.at(-1);
    assert.ok(summary);
    assert.equal(stageCount(summary, "conversation.frame"), 1);
  } finally {
    diagnostics.handle.stop();
  }
});

test("conversation.frame 仍丢弃旧 subscription 的迟到帧", async () => {
  const diagnostics = startDiagnostics();
  try {
    const store = await createConversationStore();
    store.handleFrame({
      ...conversationSnapshotFrame(9),
      subscriptionId: "stale-sub",
    } as unknown as ConversationTopicFrame);

    assert.equal(store.getState().snapshot, null, "代际守卫必须继续丢弃迟到帧");
  } finally {
    diagnostics.handle.stop();
  }
});

test("sessions-index.frame 在真实 handleFrame 路径记录且不带 workUnits", async () => {
  const diagnostics = startDiagnostics();
  try {
    const { store, deliver } = await createSessionsIndexStore();
    deliver(sessionsIndexSnapshotFrame(1));

    // 旧行为保持：snapshot 全量替换。
    assert.equal(store.getSessions().length, 1);
    assert.equal(store.getState().seq, 1);

    diagnostics.handle.flush();
    const summary = diagnostics.summaries.at(-1);
    assert.ok(summary);
    assert.equal(stageCount(summary, "sessions-index.frame"), 1);
    assert.deepEqual(stageWorkUnits(summary, "sessions-index.frame"), {
      sum: undefined,
      max: undefined,
    });
  } finally {
    diagnostics.handle.stop();
  }
});
