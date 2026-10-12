import assert from "node:assert/strict";
import test from "node:test";
import type { IsolatedHistoryJob, IsolatedHistoryJobResult } from "@zcode/contracts";
import {
  HistoryReadLane,
  canOpenHistoryReadLane,
  createHistoryReadLane,
} from "../src/storage/session-store/history-read-lane.js";
import {
  HISTORY_READ_LANE_WORKER_BUNDLE_NAME,
  historyReadLaneWorkerUrl,
  resolveHistoryReadLaneWorkerUrl,
} from "../src/storage/session-store/history-read-lane-worker-url.js";

const listJob: IsolatedHistoryJob = { kind: "list", input: {} };
const listResult: IsolatedHistoryJobResult = {
  kind: "list",
  output: {
    status: "success",
    scopeNote: "test",
    sessions: [],
    total: 0,
    offset: 0,
    truncated: false,
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

test("historyReadLaneWorkerUrl：CJS banner 定位优先于 import.meta.url", () => {
  const previous = (globalThis as { __zcodeHistoryReadLaneWorkerUrl?: unknown })
    .__zcodeHistoryReadLaneWorkerUrl;
  const expected = new URL(`file:///tmp/glm/${HISTORY_READ_LANE_WORKER_BUNDLE_NAME}`);
  (globalThis as { __zcodeHistoryReadLaneWorkerUrl?: () => URL }).__zcodeHistoryReadLaneWorkerUrl =
    () => expected;
  try {
    assert.equal(historyReadLaneWorkerUrl().href, expected.href);
  } finally {
    (globalThis as { __zcodeHistoryReadLaneWorkerUrl?: unknown }).__zcodeHistoryReadLaneWorkerUrl =
      previous;
  }
});

test("resolveHistoryReadLaneWorkerUrl：CJS 单文件产物不读空的 import.meta.url", () => {
  const bundled = `/tmp/glm/${HISTORY_READ_LANE_WORKER_BUNDLE_NAME}`;
  const url = resolveHistoryReadLaneWorkerUrl({
    argv1: "/tmp/glm/zcode.cjs",
    bundledExists: (absolutePath) => absolutePath === bundled,
  });
  assert.equal(url.pathname.endsWith(`/${HISTORY_READ_LANE_WORKER_BUNDLE_NAME}`), true);
});

test("resolveHistoryReadLaneWorkerUrl：metaUrl 缺失时不得对 undefined 调 endsWith", () => {
  assert.throws(
    () => resolveHistoryReadLaneWorkerUrl({}),
    /History read lane worker entry is missing/,
  );
});

test("resolveHistoryReadLaneWorkerUrl：源文件测试仍拉 adapters dist sibling", () => {
  const url = resolveHistoryReadLaneWorkerUrl({
    metaUrl: "file:///repo/apps/zcode-cli/packages/adapters/src/storage/session-store/history-read-lane-worker-url.ts",
  });
  assert.match(url.href, /\/dist\/storage\/session-store\/history-read-lane-worker\.js$/);
});

test("canOpenHistoryReadLane：文件路径可用，内存库不可用", () => {
  assert.equal(canOpenHistoryReadLane("/tmp/session.db"), true);
  assert.equal(canOpenHistoryReadLane(":memory:"), false);
  assert.equal(canOpenHistoryReadLane("  "), false);
});

test("HistoryReadLane：并行入队实际串行，maxObservedActive 为 1", async () => {
  let current = 0;
  const lane = createHistoryReadLane({
    dbPath: "/tmp/unused.db",
    executeJob: async () => {
      current += 1;
      assert.equal(current, 1, "同时只应有一路作业在跑");
      await delay(20);
      current -= 1;
      return listResult;
    },
  });
  try {
    await Promise.all([lane.enqueue(listJob), lane.enqueue(listJob), lane.enqueue(listJob)]);
    assert.equal(lane.stats.maxObservedActive, 1);
    assert.equal(lane.stats.active, 0);
  } finally {
    lane.dispose();
  }
});

test("HistoryReadLane：排队中的作业 abort 后不执行，当前作业不受影响", async () => {
  const started: number[] = [];
  const lane = createHistoryReadLane({
    dbPath: "/tmp/unused.db",
    executeJob: async (job) => {
      started.push(job.kind === "list" ? 1 : 0);
      await delay(30);
      return listResult;
    },
  });
  try {
    const first = lane.enqueue(listJob);
    const controller = new AbortController();
    const queued = lane.enqueue(listJob, controller.signal);
    controller.abort();
    await assert.rejects(queued, isAbortError);
    await first;
    assert.equal(started.length, 1, "被取消的排队作业不得开跑");
  } finally {
    lane.dispose();
  }
});

test("HistoryReadLane：取消正在跑的作业后队列能继续", async () => {
  let calls = 0;
  const lane = createHistoryReadLane({
    dbPath: "/tmp/unused.db",
    executeJob: async (_job, signal) => {
      calls += 1;
      if (calls === 1) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        await new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return listResult;
    },
  });
  try {
    const controller = new AbortController();
    const running = lane.enqueue(listJob, controller.signal);
    await delay(10);
    controller.abort();
    await assert.rejects(running, isAbortError);
    const next = await lane.enqueue(listJob);
    assert.equal(next.kind, "list");
  } finally {
    lane.dispose();
  }
});

test("HistoryReadLane：dispose 拒绝排队作业", async () => {
  const lane = new HistoryReadLane({
    dbPath: "/tmp/unused.db",
    executeJob: async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref();
      });
      return listResult;
    },
  });
  const running = lane.enqueue(listJob);
  const queued = lane.enqueue(listJob);
  lane.dispose();
  await assert.rejects(running, isAbortError);
  await assert.rejects(queued, isAbortError);
});
