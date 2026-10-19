import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyDiskIoMetricValues, type DiskIoMetricRow } from "@zcode/shared";
import {
  filterDiskIoRows,
  formatDiskIoDuration,
  formatDiskIoP95,
  getDiskIoP95,
  getDiskIoRateFromLatestBucket,
  sortDiskIoRows,
  summarizeDiskIoRows,
} from "../src/resource-manager/diskIoView.js";

function row(overrides: Partial<DiskIoMetricRow> = {}): DiskIoMetricRow {
  return {
    process: "main",
    module: "filesystem",
    ...createEmptyDiskIoMetricValues(),
    readOperations: 2,
    writeOperations: 1,
    readBytes: 10,
    writeBytes: 20,
    totalDurationMs: 15,
    latencyHistogram: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

test("汇总读写操作、平均耗时和固定桶 P95", () => {
  const summary = summarizeDiskIoRows([row()]);
  assert.equal(summary.operationCount, 3);
  assert.equal(summary.readBytes, 10);
  assert.equal(summary.writeBytes, 20);
  assert.equal(summary.averageDurationMs, 5);
  assert.equal(formatDiskIoP95(summary), "≤ 5 ms");
  assert.equal(formatDiskIoDuration(0.5), "500 µs");
});

test("P95 空分布和超过最大延迟桶时明确显示", () => {
  assert.deepEqual(getDiskIoP95(Array(12).fill(0)), { upperBoundMs: null, overUpperBound: false });
  const metrics = createEmptyDiskIoMetricValues();
  metrics.readOperations = 1;
  metrics.latencyHistogram[11] = 1;
  assert.equal(formatDiskIoP95(summarizeDiskIoRows([row(metrics)])), "> 5,000 ms");
});

test("来源筛选只保留匹配的进程与模块", () => {
  const rows = [
    row(),
    row({ process: "host", module: "logging" }),
    row({ process: "agent", module: "sqlite" }),
  ];
  assert.deepEqual(
    filterDiskIoRows(rows, "host", "all").map((item) => item.process),
    ["host"],
  );
  assert.deepEqual(
    filterDiskIoRows(rows, "all", "sqlite").map((item) => item.module),
    ["sqlite"],
  );
});

test("筛选进程和模块后最新桶速率与趋势采用一致口径", () => {
  const rows = [row(), row({ process: "host", module: "config", readBytes: 25 })];
  const snapshot = {
    startedAt: 0,
    sessionStartedAt: 0,
    capturedAt: 5_000,
    globalTotals: {
      readBytes: 35,
      writeBytes: 40,
      readOperations: 4,
      writeOperations: 2,
      databaseOperations: 0,
      failedOperations: 0,
    },
    historyIntervalMs: 5_000,
    historyRetentionMs: 10_000,
    osIoAvailable: false,
    cumulative: rows,
    history: [{ timestamp: 5_000, rows, osIoDelta: [] }],
    osIoCumulative: {},
    logQueuePending: 0 as const,
    logQueueDropped: 0,
  };
  assert.equal(getDiskIoRateFromLatestBucket(snapshot, "read"), 7);
  assert.equal(getDiskIoRateFromLatestBucket(snapshot, "read", "main", "all"), 2);
  assert.equal(getDiskIoRateFromLatestBucket(snapshot, "read", "host", "config"), 5);
  assert.equal(getDiskIoRateFromLatestBucket(snapshot, "read", "host", "sqlite"), 0);
});

test("排序支持按读写量、操作次数和失败数", () => {
  const rows = [row(), row({ process: "host", readBytes: 50, failedOperations: 3 })];
  assert.equal(sortDiskIoRows(rows, "readBytes", true)[0]?.process, "host");
  assert.equal(sortDiskIoRows(rows, "readBytes", false)[0]?.process, "main");
  assert.equal(sortDiskIoRows(rows, "failedOperations", true)[0]?.process, "host");
});
