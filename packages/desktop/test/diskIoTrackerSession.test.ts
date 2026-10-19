import assert from "node:assert/strict";
import test from "node:test";
import { createDiskIoTracker } from "../../shared/src/node/diskIoInstrumentationTracker.js";

test("关闭监控时只累积一个轻量桶，不采集 OS 及耗时直方图；重新开启后恢复明细", () => {
  const batches: ReturnType<ReturnType<typeof createDiskIoTracker>["flush"]>[] = [];
  const tracker = createDiskIoTracker({
    intervalMs: 60_000,
    detailedEnabled: false,
    onBatch: (batch) => {
      batches.push(batch);
    },
  });
  try {
    tracker.record("logging", "write", 100, 20, false);
    tracker.record("filesystem", "read", 20, 30, false);
    const idle = tracker.flush();
    assert.deepEqual(
      idle.groups.map((group) => group.module),
      ["other"],
    );
    assert.equal(idle.groups[0]?.metrics.readBytes, 30);
    assert.equal(idle.groups[0]?.metrics.writeBytes, 20);
    assert.equal(idle.groups[0]?.metrics.totalDurationMs, 0);
    assert.equal(
      idle.groups[0]?.metrics.latencyHistogram.reduce((sum, count) => sum + count, 0),
      0,
    );
    assert.equal(idle.osIo.readBytesDelta, null);
    tracker.setDetailedEnabled(true);
    tracker.record("logging", "write", 100, 40, false);
    const active = tracker.flush();
    assert.deepEqual(
      active.groups.map((group) => group.module),
      ["logging"],
    );
    assert.equal(active.groups[0]?.metrics.totalDurationMs, 100);
    assert.equal(
      active.groups[0]?.metrics.latencyHistogram.reduce((sum, count) => sum + count, 0),
      1,
    );
    tracker.setDetailedEnabled(false);
    tracker.record("filesystem", "read", 10, 50, false);
    assert.deepEqual(
      tracker.flush().groups.map((group) => group.module),
      ["other"],
    );
  } finally {
    tracker.stop({ flushFinal: false });
  }
});

test("更新采样间隔会重启批次定时器，而不是只改变 UI 刷新", async () => {
  const batches: number[] = [];
  const tracker = createDiskIoTracker({
    intervalMs: 1_000,
    onBatch: (batch) => {
      batches.push(batch.sequence);
    },
  });
  try {
    tracker.setIntervalMs(10);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.ok(batches.length >= 3, `expected repeated 10ms batches, got ${batches.length}`);
  } finally {
    tracker.stop({ flushFinal: false });
  }
});
