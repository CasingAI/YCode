import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";

const SESSION_ID = "sess-older-commit";
const TOPIC = conversationTopic(SESSION_ID);

function userRow(rowId: number, text: string): ConversationRow {
  return {
    kind: "userInput",
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1_000 + rowId,
    createdAtSeq: rowId,
    text,
    origin: "realUser",
  } as ConversationRow;
}

/**
 * 只填 store 真实读取的字段（rows / logEpoch / seq / queue / modelTransition），
 * 其余协议字段在这条链路上无人消费，用断言收口而不是抄一份完整快照 schema。
 */
function makeSnapshot(params: {
  rowIds: readonly number[];
  logEpoch?: string;
  firstRowId?: number | null;
}): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    logEpoch: params.logEpoch ?? "epoch-1",
    seq: 1_000,
    revision: 1,
    rows: {
      window: params.rowIds.map((rowId) => userRow(rowId, `query ${rowId}`)),
      totalCount: 2_000,
      firstRowId: params.firstRowId === undefined ? 1 : params.firstRowId,
    },
    queue: { items: [] },
    modelTransition: null,
  } as unknown as ConversationSnapshot;
}

interface Harness {
  store: ConversationProjectionStore;
  rowsRangeCalls: number;
  setRowsRange(handler: (beforeRowId: number) => V4ConversationRowsRangeResult): void;
  deliverSnapshot(snapshot: ConversationSnapshot): void;
  /** rewind / 分支裁剪：删除该行及之后所有已加载行。 */
  deliverRowRemoved(fromRowId: number): void;
  enableDeltaFrames(): Promise<void>;
}

async function createHarness(initial: ConversationSnapshot): Promise<Harness> {
  let rowsRangeCalls = 0;
  let rowsRangeHandler = (beforeRowId: number): V4ConversationRowsRangeResult => ({
    rows: [userRow(beforeRowId - 1, `older ${beforeRowId - 1}`)],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: initial.logEpoch,
    hasMore: false,
  });
  let subscribeMode: "snapshot" | "resume" = "snapshot";

  const transport = {
    subscribe: async () => ({
      ack: {
        subscriptionId: "sub-1",
        logEpoch: initial.logEpoch,
        mode: subscribeMode,
      },
    }),
    activate: () => {},
    unsubscribe: async () => {},
    resync: async () => ({ frames: [] }),
    rowsRange: async ({ beforeRowId }: { beforeRowId?: number }) => {
      rowsRangeCalls += 1;
      return rowsRangeHandler(beforeRowId ?? Number.MAX_SAFE_INTEGER);
    },
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport;

  const store = new ConversationProjectionStore(TOPIC, transport);
  await store.connect();
  // 帧由 SessionDataLayer 路由进 store，不走 transport.onFrame。
  // fromSeq 必须接住当前水位，否则 store 按断档处理（规则 2）而不落增量。
  const deliver = (payload: unknown, toSeq: number, fromSeq = 0) => {
    store.handleFrame({
      topic: TOPIC,
      subscriptionId: "sub-1",
      fromSeq,
      toSeq,
      sentAt: 1_000,
      payload,
    } as unknown as ConversationTopicFrame);
  };

  deliver({ kind: "snapshot", snapshot: initial }, 1_000);

  return {
    store,
    get rowsRangeCalls() {
      return rowsRangeCalls;
    },
    setRowsRange(handler) {
      rowsRangeHandler = handler;
    },
    /**
     * 增量帧只在 store 持有已证明的 applied base 时才被消费，而 base 由 resume 模式的
     * ACK 建立（见 store 的 subscriptionHasAppliedBase 赋值）。要测 row.removed 这条
     * 真实 rewind 路径，得先按 resume 重订阅一次。
     */
    async enableDeltaFrames(): Promise<void> {
      subscribeMode = "resume";
      await store.connect();
    },
    deliverSnapshot(snapshot) {
      deliver({ kind: "snapshot", snapshot }, 1_000);
    },
    deliverRowRemoved(fromRowId) {
      deliver({ kind: "deltas", deltas: [{ op: "row.removed", fromRowId }] }, 1_001, 1_000);
    },
  };
}

test("取数完成只进缓冲，不动窗口；提交才前插", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  const before = harness.store.getState().snapshot?.rows.window.map((row) => row.rowId);

  await harness.store.loadOlder();

  const buffered = harness.store.getState();
  assert.deepEqual(
    buffered.snapshot?.rows.window.map((row) => row.rowId),
    before,
    "取数完成不得替换窗口",
  );
  assert.equal(buffered.pendingOlder?.rows.length, 1);
  assert.equal(buffered.loadingOlder, true, "缓冲未提交前 loadingOlder 不能翻 false");

  const result = harness.store.commitPendingOlder();

  assert.deepEqual(result, { committed: true });
  const committed = harness.store.getState();
  assert.deepEqual(
    committed.snapshot?.rows.window.map((row) => row.rowId),
    [99, 100, 200],
  );
  assert.equal(committed.pendingOlder, null);
  assert.equal(committed.loadingOlder, false, "提交完成才允许翻 false");
});

test("缓冲期间 loadingOlder 保持 true：find 自动补页要等内容真的落进来", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100] }));
  await harness.store.loadOlder();
  assert.equal(harness.store.getState().loadingOlder, true);
  harness.store.commitPendingOlder();
  assert.equal(harness.store.getState().loadingOlder, false);
});

test("同一时刻只允许一个取数请求在途（单飞）", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100] }));
  await Promise.all([harness.store.loadOlder(), harness.store.loadOlder()]);
  assert.equal(harness.rowsRangeCalls, 1, "单飞应只发一次");
});

test("补齐事务：缓冲开着时按推进过的游标取下一页，多页累积进同一个缓冲", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  const cursors: number[] = [];
  harness.setRowsRange((beforeRowId) => {
    cursors.push(beforeRowId);
    // 每一页都还有更早历史，逼补齐循环一直往下取。
    return {
      rows: [userRow(beforeRowId - 1, `older ${beforeRowId - 1}`)],
      atSeq: 1_000,
      atRevision: 1,
      atLogEpoch: "epoch-1",
      hasMore: true,
    };
  });

  await harness.store.loadOlder();
  await harness.store.loadOlder();

  assert.deepEqual(cursors, [100, 99], "第二页游标必须是已取到的最小 rowId，不是窗口首行");
  const buffered = harness.store.getState();
  assert.deepEqual(
    buffered.pendingOlder?.rows.map((row) => row.rowId),
    [98, 99],
    "两页按 rowId 升序累积进同一个缓冲，窗口仍不动",
  );
  assert.deepEqual(
    buffered.snapshot?.rows.window.map((row) => row.rowId),
    [100, 200],
  );
  assert.equal(buffered.pendingOlder?.pages, 2);
  assert.equal(buffered.pendingOlder?.hasMoreOlder, true, "还有更早历史，补齐不能停");

  assert.deepEqual(harness.store.commitPendingOlder(), { committed: true });
  assert.deepEqual(
    harness.store.getState().snapshot?.rows.window.map((row) => row.rowId),
    [98, 99, 100, 200],
    "一次提交把整个补齐事务并入",
  );
});

test("hasMoreOlder=false 是停止条件：探到真实顶部后不再取页", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100] }));
  await harness.store.loadOlder();
  assert.equal(harness.store.getState().pendingOlder?.hasMoreOlder, false);
  await harness.store.loadOlder();
  assert.equal(harness.rowsRangeCalls, 1, "已到顶部，补齐循环必须停在这里");
});

test("fetchingOlder 只覆盖「请求在途」，缓冲未提交期间翻 false", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100] }));
  assert.equal(harness.store.getState().fetchingOlder, false);
  await harness.store.loadOlder();
  const buffered = harness.store.getState();
  assert.equal(buffered.fetchingOlder, false, "请求已落地，但缓冲还开着");
  assert.equal(buffered.loadingOlder, true);
});

test("缓冲期间 rewind 裁掉窗口首行：整批丢弃并要求按新游标重取", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 150, 200] }));
  await harness.enableDeltaFrames();
  await harness.store.loadOlder();
  assert.notEqual(harness.store.getState().pendingOlder, null);

  // rewind 裁到窗口首行之前：已加载的行全被移除，缓冲那一页的游标随之失效。
  harness.deliverRowRemoved(100);
  assert.deepEqual(harness.store.getState().snapshot?.rows.window, []);

  const result = harness.store.commitPendingOlder();

  assert.deepEqual(result, { committed: false, retry: true });
  const after = harness.store.getState();
  assert.equal(after.pendingOlder, null, "失效的缓冲必须清掉");
  assert.equal(after.loadingOlder, false);
});

test("整窗快照替换后提交作废，并把重取信号交回调用方", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  await harness.store.loadOlder();
  assert.notEqual(harness.store.getState().pendingOlder, null);

  harness.deliverSnapshot(makeSnapshot({ rowIds: [500, 600], logEpoch: "epoch-1" }));

  // 缓冲刻意留到提交时才判：只有这样才能告诉调用方「新窗口的更早内容还没拉」。
  assert.notEqual(harness.store.getState().pendingOlder, null);
  assert.deepEqual(harness.store.commitPendingOlder(), {
    committed: false,
    retry: true,
  });
  const state = harness.store.getState();
  assert.equal(state.pendingOlder, null);
  assert.equal(state.loadingOlder, false);
  assert.deepEqual(
    state.snapshot?.rows.window.map((row) => row.rowId),
    [500, 600],
    "不能把旧窗口的行拼进新窗口",
  );
});

test("缓冲期间纪元换代：整批丢弃，不跨纪元拼接", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  await harness.store.loadOlder();
  // CLI 重启后的新纪元投影恰好从同一个 rowId 起，看起来像「游标仍然有效」。
  harness.deliverSnapshot(makeSnapshot({ rowIds: [100, 200], logEpoch: "epoch-2" }));

  assert.deepEqual(harness.store.commitPendingOlder(), {
    committed: false,
    retry: true,
  });
  assert.deepEqual(
    harness.store.getState().snapshot?.rows.window.map((row) => row.rowId),
    [100, 200],
  );
});

test("这一页没有更早内容时不并入，且不要重试（否则会自旋）", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  harness.setRowsRange(() => ({
    rows: [userRow(300, "更新的一行")],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: "epoch-1",
    hasMore: false,
  }));

  await harness.store.loadOlder();
  const result = harness.store.commitPendingOlder();

  assert.deepEqual(result, { committed: false, retry: false });
  const state = harness.store.getState();
  assert.equal(state.pendingOlder, null);
  assert.deepEqual(
    state.snapshot?.rows.window.map((row) => row.rowId),
    [100, 200],
  );
});

test("纪元不匹配的取数结果不进缓冲", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  harness.setRowsRange(() => ({
    rows: [userRow(99, "另一个纪元的行")],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: "epoch-跨重启",
    hasMore: false,
  }));

  await harness.store.loadOlder();

  const state = harness.store.getState();
  assert.equal(state.pendingOlder, null);
  assert.equal(state.loadingOlder, false);
  assert.deepEqual(
    state.snapshot?.rows.window.map((row) => row.rowId),
    [100, 200],
  );
});

test("没有缓冲时提交是 no-op", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  assert.deepEqual(harness.store.commitPendingOlder(), {
    committed: false,
    retry: false,
  });
  assert.deepEqual(
    harness.store.getState().snapshot?.rows.window.map((row) => row.rowId),
    [100, 200],
  );
});

test("提交是幂等的：同一份缓冲不会被并入两次", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  await harness.store.loadOlder();
  assert.deepEqual(harness.store.commitPendingOlder(), { committed: true });
  assert.deepEqual(harness.store.commitPendingOlder(), {
    committed: false,
    retry: false,
  });
  assert.deepEqual(
    harness.store.getState().snapshot?.rows.window.map((row) => row.rowId),
    [99, 100, 200],
  );
});

// 2026-09-28：rowsRange 确定性失败（行过不了协议校验）曾形成「失败 → loadingOlder
// 回落 → 占位块消失（inset −56）→ 平移发出的 scroll 又满足预取 → 立即重试」的自旋
// （实测一秒 29 次 RPC、占位块 ±56 闪烁）。失败后必须进冷却：冷却窗口内的触发直接
// 跳过。「冷却到期后恢复」由 `Date.now() < retryAfter` 守卫自然成立，不在假时钟上重复。
test("rowsRange 失败后进入冷却：冷却窗口内的重试不再发请求", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  harness.setRowsRange(() => {
    throw new Error("ZodError: rows[44].admissionMode");
  });

  await harness.store.loadOlder();
  assert.equal(harness.rowsRangeCalls, 1);
  // 失败回落后的状态：无缓冲、loadingOlder 归零（占位块随它消失）。
  const state = harness.store.getState();
  assert.equal(state.pendingOlder, null);
  assert.equal(state.loadingOlder, false);

  // 冷却窗口内连触多次（对应滚动平移引发的连续预取），一次都不发。
  await harness.store.loadOlder();
  await harness.store.loadOlder();
  await harness.store.loadOlder();
  assert.equal(harness.rowsRangeCalls, 1);
});

// ---------------------------------------------------------------------------
// 上滚补齐的中断信号（olderFillInterruptedSeq）：loadOlder 的每一条不产生窗口
// 变化的路径都必须留下显式状态变化——静默 return 会让闸门请求已被消费、缓冲状态
// 不变、没有任何 effect 依赖再变化，填充循环与提交同时无人唤醒（曾因此「正在加载
// 更早消息」永久显示且滚动锁永不解除）。见 turn-window-fill spec 规则 11b。

test("纪元不匹配丢弃：bump 中断信号，缓冲保留", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  const before = harness.store.getState().olderFillInterruptedSeq;

  // 第一页正常入缓冲（hasMore=true，补齐事务开着）。
  harness.setRowsRange(() => ({
    rows: [userRow(99, "older 99")],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: "epoch-1",
    hasMore: true,
  }));
  await harness.store.loadOlder();
  assert.notEqual(harness.store.getState().pendingOlder, null);

  // 第二页返回时 CLI 已重启（纪元不匹配）：整页作废但必须 bump 信号。
  harness.setRowsRange(() => ({
    rows: [userRow(98, "older 98")],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: "epoch-跨重启",
    hasMore: true,
  }));
  await harness.store.loadOlder();

  const state = harness.store.getState();
  assert.equal(state.olderFillInterruptedSeq, before + 1, "丢弃必须留下显式状态变化");
  assert.notEqual(state.pendingOlder, null, "缓冲留到提交时按游标校验裁决");
});

test("锚点失配丢弃：bump 中断信号", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 150, 200] }));
  harness.setRowsRange(() => ({
    rows: [userRow(99, "older 99")],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: "epoch-1",
    hasMore: true,
  }));
  await harness.store.loadOlder();
  const before = harness.store.getState().olderFillInterruptedSeq;

  // 整窗替换（快照 resync / 换窗）改写窗口首行 → 事务锚点失效；下一页取回时
  // 在锚点校验处整页作废。缓冲留到提交时按游标校验裁决，信号必须已 bump。
  harness.deliverSnapshot(makeSnapshot({ rowIds: [500, 600], logEpoch: "epoch-1" }));
  await harness.store.loadOlder();

  const state = harness.store.getState();
  assert.equal(state.olderFillInterruptedSeq, before + 1);
  assert.notEqual(state.pendingOlder, null);
});

test("连续丢弃达上限：作废缓冲解锁并进冷却，无请求自旋", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  const before = harness.store.getState().olderFillInterruptedSeq;
  harness.setRowsRange(() => ({
    rows: [userRow(99, "older 99")],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: "epoch-持续换代",
    hasMore: true,
  }));

  await harness.store.loadOlder();
  await harness.store.loadOlder();
  // 前两次丢弃只 bump（三页都是第一页即丢，缓冲从未建立）。
  assert.equal(harness.store.getState().olderFillInterruptedSeq, before + 2);

  await harness.store.loadOlder();
  const state = harness.store.getState();
  assert.equal(state.olderFillInterruptedSeq, before + 3, "三次丢弃各 bump 一次");
  assert.equal(state.pendingOlder, null, "达上限必须作废缓冲：滚动锁随 hasPendingOlder 解除");
  assert.equal(state.loadingOlder, false, "占位块随 loadingOlder 消失");

  // 冷却窗口内的再次触发不发请求（防持续换代自旋）。
  const calls = harness.rowsRangeCalls;
  await harness.store.loadOlder();
  assert.equal(harness.rowsRangeCalls, calls);
});

test("取数失败且缓冲非空：bump 中断信号让已取部分可提交；缓冲空时不 bump", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  const before = harness.store.getState().olderFillInterruptedSeq;

  // 第一页正常入缓冲（hasMore=true，事务开着），第二页失败：锚点仍有效。
  harness.setRowsRange(() => ({
    rows: [userRow(99, "older 99")],
    atSeq: 1_000,
    atRevision: 1,
    atLogEpoch: "epoch-1",
    hasMore: true,
  }));
  await harness.store.loadOlder();
  harness.setRowsRange(() => {
    throw new Error("transport gone");
  });
  await harness.store.loadOlder();
  assert.equal(harness.store.getState().olderFillInterruptedSeq, before + 1);
  assert.notEqual(harness.store.getState().pendingOlder, null, "已取部分留给提交");

  // 失败 + 无缓冲：锁没落（hasPendingOlder=false），无需信号。
  harness.store.commitPendingOlder();
  const afterCommit = harness.store.getState().olderFillInterruptedSeq;
  await harness.store.loadOlder();
  assert.equal(harness.store.getState().olderFillInterruptedSeq, afterCommit);
});

test("成功取页清零连续丢弃计数：偶发丢弃不累积触发作废", async () => {
  const harness = await createHarness(makeSnapshot({ rowIds: [100, 200] }));
  let discard = true;
  harness.setRowsRange(() => {
    if (discard) {
      return {
        rows: [userRow(99, "older 99")],
        atSeq: 1_000,
        atRevision: 1,
        atLogEpoch: "epoch-换代",
        hasMore: true,
      };
    }
    return {
      rows: [userRow(99, "older 99")],
      atSeq: 1_000,
      atRevision: 1,
      atLogEpoch: "epoch-1",
      hasMore: true,
    };
  });

  // 丢、丢、成、丢、丢：第二次的「成」把计数清零，最后两次不该触发作废。
  discard = true;
  await harness.store.loadOlder();
  await harness.store.loadOlder();
  discard = false;
  await harness.store.loadOlder();
  discard = true;
  await harness.store.loadOlder();
  await harness.store.loadOlder();

  const state = harness.store.getState();
  assert.notEqual(state.pendingOlder, null, "未达连续上限，缓冲不得作废");
  assert.equal(state.pendingOlder?.hasMoreOlder, true);
});
