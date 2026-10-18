import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyDiskIoMetricValues,
  type DiskIoMetricBatch,
} from "@zcode/shared";
import { DiskIoTelemetryStore } from "../src/main/diskIoTelemetryStore.js";

function batch(overrides: Partial<DiskIoMetricBatch> = {}): DiskIoMetricBatch {
  return {
    schemaVersion: 1,
    instanceId: "main-instance-0001",
    sequence: 1,
    capturedAt: 10_000,
    groups: [
      {
        module: "filesystem",
        metrics: {
          ...createEmptyDiskIoMetricValues(),
          readOperations: 2,
          writeOperations: 1,
          readBytes: 128,
          writeBytes: 64,
          totalDurationMs: 12,
          latencyHistogram: [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
        },
      },
    ],
    osIo: { available: true, readBytesDelta: 256, writeBytesDelta: 512 },
    ...overrides,
  };
}

test("磁盘 I/O 汇总拒绝重复批次，逻辑字节与 OS 字节分别累计", () => {
  let now = 10_000;
  const store = new DiskIoTelemetryStore({ osIoAvailable: true, now: () => now });
  assert.equal(store.ingestBatch("main", batch()), true);
  assert.equal(store.ingestBatch("main", batch()), false, "同一序号不得重复累计");

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.cumulative[0]?.readBytes, 128);
  assert.equal(snapshot.cumulative[0]?.writeBytes, 64);
  assert.equal(snapshot.osIoCumulative.main?.readBytes, 256);
  assert.equal(snapshot.osIoCumulative.main?.writeBytes, 512);
  assert.equal(snapshot.osIoAvailable, true);

  now += 5_000;
  assert.equal(store.ingestBatch("main", batch({ sequence: 2, capturedAt: now })), true);
  store.flushHistory(now);
  const next = store.getSnapshot();
  assert.equal(next.cumulative[0]?.readBytes, 256);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0]?.rows[0]?.readBytes, 256, "同一采样桶内的多个增量会合并");
});

test("磁盘 I/O 历史固定长度淘汰，进程退出后的旧实例不会无限保留", () => {
  const store = new DiskIoTelemetryStore({
    osIoAvailable: false,
    now: () => 20_000,
    historyBuckets: 2,
    historyIntervalMs: 5_000,
  });
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    store.ingestBatch(
      "host",
      batch({ instanceId: "host-instance-0001", sequence, capturedAt: 20_000 + sequence * 5_000 }),
    );
    store.flushHistory(20_000 + sequence * 5_000);
  }
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.history.length, 2);
  assert.equal(snapshot.historyRetentionMs, 10_000);
  assert.equal(snapshot.osIoAvailable, false);
  assert.equal(snapshot.osIoCumulative.host, undefined);
  assert.equal(snapshot.cumulative[0]?.readBytes, 512);
});

test("日志丢弃只统计日志写入失败，不把读取失败混入", () => {
  const store = new DiskIoTelemetryStore({ osIoAvailable: false });
  const loggingMetrics = {
    ...createEmptyDiskIoMetricValues(),
    failedOperations: 2,
    failedReadOperations: 1,
    failedWriteOperations: 1,
  };
  store.ingestBatch(
    "main",
    batch({
      groups: [{ module: "logging", metrics: loggingMetrics }],
      osIo: { available: false, readBytesDelta: null, writeBytesDelta: null },
    }),
  );
  assert.equal(store.getSnapshot().logQueueDropped, 1);
});

test("无效批次不会污染累计统计", () => {
  const store = new DiskIoTelemetryStore({ osIoAvailable: false });
  assert.equal(store.ingestBatch("agent", { ...batch(), sequence: -1 }), false);
  assert.equal(store.getSnapshot().cumulative.length, 0);
});
