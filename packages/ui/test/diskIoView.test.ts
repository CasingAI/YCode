import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyDiskIoMetricValues, type DiskIoMetricRow } from "@zcode/shared";
import {
  filterDiskIoRows,
  formatDiskIoDuration,
  formatDiskIoP95,
  getDiskIoP95,
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
  const rows = [row(), row({ process: "host", module: "logging" }), row({ process: "agent", module: "sqlite" })];
  assert.deepEqual(filterDiskIoRows(rows, "host", "all").map((item) => item.process), ["host"]);
  assert.deepEqual(filterDiskIoRows(rows, "all", "sqlite").map((item) => item.module), ["sqlite"]);
});
