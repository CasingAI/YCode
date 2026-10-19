import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyDiskIoMetricValues, type DiskIoMetricBatch } from "@zcode/shared";
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
  store.startSession();
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

test("实时趋势默认只在内存中保留最近 5 分钟的历史", () => {
  const store = new DiskIoTelemetryStore({ osIoAvailable: false });
  assert.equal(store.getSnapshot().historyRetentionMs, 5 * 60_000);
});

test("磁盘 I/O 历史固定长度淘汰，进程退出后的旧实例不会无限保留", () => {
  const store = new DiskIoTelemetryStore({
    osIoAvailable: false,
    now: () => 20_000,
    historyBuckets: 2,
    historyIntervalMs: 5_000,
  });
  store.startSession();
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
  store.startSession();
  const loggingMetrics = {
    ...createEmptyDiskIoMetricValues(),
    failedOperations: 2,
    failedReadOperations: 1,
    failedWriteOperations: 1,
  };
  store.ingestBatch(
    "main",
    batch({
      capturedAt: Date.now(),
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

test("未打开监控窗口只累计轻量总数，不创建任何进程/模块明细或历史", () => {
  const store = new DiskIoTelemetryStore({ osIoAvailable: true, now: () => 10_000 });
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    assert.equal(store.ingestBatch("host", batch({ sequence })), true);
    store.flushHistory(10_000 + sequence * 5_000);
  }
  const result = store.getSnapshot();
  assert.equal(result.sessionStartedAt, null);
  assert.equal(result.globalTotals.readBytes, 384);
  assert.equal(result.globalTotals.writeOperations, 3);
  assert.equal(result.cumulative.length, 0);
  assert.equal(result.history.length, 0);
  assert.equal(result.osIoAvailable, false);
  assert.deepEqual(result.osIoCumulative, {});
});

test("窗口会话隔离：切换标签不重置，关闭后清空明细，重新打开不补采历史", () => {
  let now = 20_000;
  const store = new DiskIoTelemetryStore({ osIoAvailable: true, now: () => now });
  store.ingestBatch("main", batch());
  store.startSession();
  store.startSession(); // 同一窗口内切换标签，不应丢弃正在采集的内容。
  store.ingestBatch("main", batch({ sequence: 2, capturedAt: now }));
  store.flushHistory(now);
  assert.equal(store.getSnapshot().cumulative[0]?.readBytes, 128);
  assert.equal(store.getSnapshot().history.length, 1);
  store.stopSession();
  store.stopSession();
  now = 30_000;
  store.ingestBatch("main", batch({ sequence: 3 }));
  store.flushHistory(now);
  let current = store.getSnapshot();
  assert.equal(current.cumulative.length, 0);
  assert.equal(current.history.length, 0);
  assert.equal(current.globalTotals.readBytes, 384);
  store.startSession();
  current = store.getSnapshot();
  assert.equal(current.sessionStartedAt, now);
  assert.equal(current.history.length, 0);
  assert.equal(current.cumulative.length, 0);
  store.ingestBatch("main", batch({ sequence: 4, capturedAt: now }));
  store.flushHistory(now + 5_000);
  assert.equal(store.getSnapshot().cumulative[0]?.readBytes, 128);
  assert.equal(store.getSnapshot().globalTotals.readBytes, 512);
  assert.equal(store.getSnapshot().history.length, 1);
});

test("进程延迟上报的旧会话批次只影响全局计数，不污染新会话明细", () => {
  let now = 40_000;
  const store = new DiskIoTelemetryStore({ osIoAvailable: true, now: () => now });
  store.startSession();
  assert.equal(store.ingestBatch("host", batch({ capturedAt: 39_000 })), true);
  assert.equal(store.getSnapshot().globalTotals.readBytes, 128);
  assert.equal(store.getSnapshot().cumulative.length, 0);
  assert.equal(store.getSnapshot().osIoAvailable, false);
  now += 5_000;
  assert.equal(store.ingestBatch("host", batch({ sequence: 2, capturedAt: now })), true);
  assert.equal(store.getSnapshot().cumulative[0]?.readBytes, 128);
});

test("调整采样间隔时保持 5 分钟实时窗口，并按新间隔计算速率", () => {
  let now = 0;
  const store = new DiskIoTelemetryStore({
    osIoAvailable: false,
    now: () => now,
    historyIntervalMs: 5_000,
    historyRetentionMs: 5 * 60_000,
  });
  store.startSession();
  store.setHistoryIntervalMs(1_000);
  for (let sequence = 1; sequence <= 350; sequence += 1) {
    now = sequence * 1_000;
    store.ingestBatch("main", batch({ sequence, capturedAt: now }));
    store.flushHistory(now);
  }
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.historyIntervalMs, 1_000);
  assert.equal(snapshot.historyRetentionMs, 5 * 60_000);
  assert.equal(snapshot.history.length, 300);
  assert.ok((snapshot.history[0]?.timestamp ?? 0) >= now - 5 * 60_000);
});
