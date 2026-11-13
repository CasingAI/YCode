/**
 * 时间线 fixture 的受控历史与 transport 片段：会话数据、分页、推送与 store 接线。
 *
 * 与 host 片段拼接成同一个 ES 模块；两段共享同一作用域，不能各自声明同名变量。
 */
export const TIMELINE_DATA_SOURCE = `
const SESSION_IDS = ["sess-cost-a", "sess-cost-b"];
const TURN_COUNT = 21;
const ROWS_PER_TURN = 5;
// 首窗只给最后 1 轮：单轮高度不足一屏，首绘 staging 必须由补齐循环真实取页。
const TAIL_TURNS = 1;
// 每页 10 整轮：单页稳定超过一屏，首绘只取 1 页；剩余 10 轮留给一次前插补齐。
const PAGE_TURNS = 10;
const INITIAL_SEQ = 1000;
// 与 SessionPhase（zcode-protocol-v4/snapshot.ts 的 sessionPhaseSchema）逐字一致。
const SESSION_PHASES = [
  "draft",
  "prewarming",
  "running",
  "completedSuccess",
  "completedInterrupted",
  "error",
];
const TIMELINE_SELECTOR = '[data-testid="v4-timeline"]';
const STAGING_SELECTOR = "[data-v4-timeline-first-paint-staging]";
const STAGED_PREPEND_SELECTOR = '[data-staged-turn="true"]';

// 夹具读数走探针 raw getter，既拿到真实值，又不会被算成产品读取。
function rawGet(element, property) {
  const probe = globalThis.__probe;
  return probe && probe.raw ? probe.raw.get(element, property) : element[property];
}
function rawRect(element) {
  const probe = globalThis.__probe;
  return probe && probe.rawRect ? probe.rawRect(element) : element.getBoundingClientRect();
}
function rawSet(element, property, value) {
  const probe = globalThis.__probe;
  if (probe && probe.raw) probe.raw.set(element, property, value);
  else element[property] = value;
}
function timelineElement() {
  return document.querySelector(TIMELINE_SELECTOR);
}
function computeFirstVisibleTurn(element) {
  const containerRect = rawRect(element);
  let best = null;
  for (const section of element.querySelectorAll("section[data-turn-id]")) {
    const rect = rawRect(section);
    if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
    if (!best || rect.top < best.top) best = { top: rect.top, id: section.getAttribute("data-turn-id") };
  }
  return best ? best.id : null;
}
function buildRows(sessionIndex) {
  const rows = [];
  let rowId = 0;
  for (let turnIndex = 0; turnIndex < TURN_COUNT; turnIndex += 1) {
    const running = turnIndex === TURN_COUNT - 1;
    const turnId = "s" + (sessionIndex + 1) + "-turn-" + (turnIndex + 1);
    const createdAt = 1_700_000_000_000 + sessionIndex * 100_000 + rowId;
    const base = { turnId, createdAt, createdAtSeq: INITIAL_SEQ + rowId };
    rowId += 1;
    rows.push({
      ...base, kind: "turnHeader", rowId, origin: "userInput", executionKind: "agent",
      state: running ? "running" : "completedSuccess",
      startedAt: createdAt, endedAt: running ? undefined : createdAt + 5_000,
    });
    rowId += 1;
    rows.push({
      ...base, kind: "userInput", rowId, origin: "realUser",
      text: "会话 " + (sessionIndex + 1) + " 第 " + (turnIndex + 1) + " 轮：检查工作区状态。",
    });
    rowId += 1;
    rows.push({
      ...base, kind: "toolCall", rowId,
      toolCallId: "call-" + (sessionIndex + 1) + "-" + turnIndex + "-read",
      toolName: "Read", status: "success",
      inputText: '{"file_path":"/workspace/notes.md"}',
      input: { file_path: "/workspace/notes.md" }, output: { text: "notes ok" },
    });
    rowId += 1;
    rows.push({
      ...base, kind: "toolCall", rowId,
      toolCallId: "call-" + (sessionIndex + 1) + "-" + turnIndex + "-bash",
      toolName: "Bash", status: "success",
      inputText: '{"command":"pnpm lint"}',
      input: { command: "pnpm lint" }, output: { text: "lint ok" },
    });
    rowId += 1;
    // 正文放长：单轮高度稳定大于 100px，整页 10 轮必然铺满视口，首绘只取 1 页。
    rows.push({
      ...base, kind: "assistantText", rowId,
      text: (
        "第 " + (turnIndex + 1) + " 轮结论：工作区结构稳定，未发现阻塞项。" +
        "这里放一段足够长的正文参与测高，让虚拟列表的高度估计与真实布局都参与测量。" +
        "补充说明：本轮检查覆盖构建、测试与格式检查，没有新增失败项。" +
        "再次确认：命令退出码为 0，日志中没有权限或网络错误。"
      ),
      state: running ? "streaming" : "complete",
    });
  }
  return rows;
}

const MODELS = SESSION_IDS.map(function (sessionId, index) {
  const rows = buildRows(index);
  const tailStart = Math.max(0, rows.length - TAIL_TURNS * ROWS_PER_TURN);
  return {
    index, sessionId, topic: "conversation/" + sessionId,
    subscriptionId: "cost-sub-" + (index + 1), logEpoch: "cost-epoch",
    revision: 1, seq: INITIAL_SEQ, rows: rows, tailStart: tailStart,
  };
});

function makeSnapshot(model) {
  const tail = model.rows.slice(model.tailStart);
  return {
    protocolVersion: 1, sessionId: model.sessionId, logEpoch: model.logEpoch,
    seq: model.seq, revision: model.revision,
    rows: {
      window: tail,
      totalCount: model.rows.length,
      // 全序首行（不是窗口首行）：hasOlderRows 用它判定窗口之上还有更早历史。
      firstRowId: model.rows.length > 0 ? model.rows[0].rowId : null,
    },
    queue: { items: [] }, modelTransition: null, pendingCommands: [],
    subagents: { running: [] }, backgroundWorks: [],
  };
}

function makeTransport(model) {
  return {
    subscribe: async () => ({
      ack: { subscriptionId: model.subscriptionId, logEpoch: model.logEpoch, mode: "snapshot" },
    }),
    activate: function () {},
    unsubscribe: async function () {},
    resync: async function () { return { frames: [] }; },
    // 真实分页：游标来自窗口/事务游标，hasMore 由「还有更早行」决定，没有页数上限。
    rowsRange: async function (params) {
      const stagingPresent = document.querySelector(STAGING_SELECTOR) !== null;
      STATS.rowsRangeCalls += 1;
      STATS.inFlight += 1;
      if (STATS.inFlight > STATS.inFlightMax) STATS.inFlightMax = STATS.inFlight;
      try {
        const beforeRowId = params && params.beforeRowId;
        const all = model.rows;
        let end = 0;
        for (let index = 0; index < all.length; index += 1) {
          if (all[index].rowId === beforeRowId) { end = index; break; }
        }
        const pageSize = PAGE_TURNS * ROWS_PER_TURN;
        const start = Math.max(0, end - pageSize);
        const rows = all.slice(start, end);
        if (rows.length > 0) STATS.pagesFetched += 1;
        if (stagingPresent) STATS.stagingFetchCount += 1;
        return {
          rows: rows, atSeq: model.seq, atRevision: model.revision,
          atLogEpoch: model.logEpoch, hasMore: start > 0,
        };
      } finally {
        STATS.inFlight -= 1;
      }
    },
    onFrame: function () { return function () {}; },
    onAssemblyFault: function () { return function () {}; },
    onRuntimeRestart: function () { return function () {}; },
  };
}

const STORES = MODELS.map(function (model) {
  return new ConversationProjectionStore(model.topic, makeTransport(model));
});

function deliverSnapshot(model, store) {
  store.handleFrame({
    topic: model.topic, subscriptionId: model.subscriptionId,
    fromSeq: 0, toSeq: model.seq, sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot: makeSnapshot(model) },
  });
}

function findStreamingRowIndex(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === "assistantText" && row.state === "streaming") return index;
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].kind === "assistantText") return index;
  }
  return -1;
}

function pushUpdates(sessionIndex, count) {
  const model = MODELS[sessionIndex];
  if (!model) return;
  const store = STORES[sessionIndex];
  const targetIndex = findStreamingRowIndex(model.rows);
  if (targetIndex < 0) return;
  let row = model.rows[targetIndex];
  for (let step = 0; step < count; step += 1) {
    model.seq += 1;
    model.revision += 1;
    row = { ...row, text: row.text + " ·" };
    model.rows[targetIndex] = row;
    store.handleFrame({
      topic: model.topic, subscriptionId: model.subscriptionId,
      fromSeq: model.seq - 1, toSeq: model.seq, sentAt: Date.now(),
      payload: { kind: "deltas", deltas: [{ op: "row.upserted", row: row }] },
    });
  }
}

function useStoreState(store) {
  const subscribe = useCallback(function (listener) { return store.subscribe(listener); }, [store]);
  const getSnapshot = useCallback(function () { return store.getState(); }, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const PLATFORM = { onSettingsChanged: function () { return function () {}; }, syncAppSettings: function () {} };
const SERVICES = {
  broadcastService: { send: async function () { return {}; } },
  settingService: { get: async function () { return {}; }, update: async function () { return {}; } },
  zcodeAgentService: { syncAppRuntimePreferences: async function () { return {}; } },
  fileService: { readMediaPreview: async function () { return { dataBase64: "", mimeType: "image/png" }; } },
};

const knownSessionIds = new Set(SESSION_IDS);

function readTurnCounts() {
  const map = globalThis.__costTurnCounts;
  if (!map) return {};
  const result = {};
  for (const entry of map) {
    result[entry[0]] = { count: entry[1].count, isRunning: entry[1].isRunning };
  }
  return result;
}
`;
