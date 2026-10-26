import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResourceUsageProcess } from "@zcode/shared";
import { buildResourceUsageProcessSummary } from "../src/main/resourceManagerSnapshot.js";

function processRow(pid: number, cpuPercent: number, sampled = true): ResourceUsageProcess {
  return {
    pid,
    name: `process-${pid}`,
    category: "base",
    groupKey: "host",
    groupLabel: "host",
    cpuPercent,
    memoryBytes: cpuPercent * 1024,
    sampled,
  };
}

function hostRow(pid: number, cpuPercent: number) {
  const { sampled: _sampled, ...row } = processRow(pid, cpuPercent);
  return row;
}

test("Electron 和多个 Host 重复报告同一 PID 时只统计一次，保留会话来源", () => {
  const summary = buildResourceUsageProcessSummary(
    [processRow(1, 2)],
    [
      {
        samplingStatus: "complete",
        processes: [hostRow(1, 30), { ...hostRow(2, 5), sessionId: "session-1" }],
      },
      { samplingStatus: "complete", processes: [hostRow(2, 50), hostRow(3, 7)] },
    ],
    [processRow(2, 0, false)],
  );
  assert.deepEqual(
    summary.processes.map((row) => row.pid),
    [1, 2, 3],
  );
  assert.equal(summary.processes[1]?.sessionId, "session-1");
  assert.deepEqual(summary.app, { cpuPercent: 14, memoryBytes: 14 * 1024 });
  assert.equal(summary.samplingStatus, "complete");
});

test("没有回帖的 Agent 保留占位，Electron 小计不能标成完整总量", () => {
  const summary = buildResourceUsageProcessSummary(
    [processRow(1, 12.3)],
    [{ samplingStatus: "pending", processes: [] }],
    [processRow(2, 0, false)],
  );
  assert.equal(summary.samplingStatus, "pending");
  assert.equal(summary.processes[1]?.sampled, false);
  assert.equal(summary.app.cpuPercent, 12.3);
});

test("失败或旧缓存即使有进程行也不能冒充本轮已采样指标", () => {
  for (const samplingStatus of ["failed", "stale"] as const) {
    const summary = buildResourceUsageProcessSummary(
      [processRow(1, 2)],
      [{ samplingStatus, processes: [hostRow(2, 20)] }],
      [],
    );
    assert.equal(summary.samplingStatus, samplingStatus);
    assert.equal(summary.processes[1]?.sampled, false);
    assert.equal(summary.app.cpuPercent, 2);
  }
});

test("部分 Host 失败时整机应用状态为失败，后续完整回帖可恢复", () => {
  const pending = { samplingStatus: "pending" as const, processes: [] };
  const failed = { samplingStatus: "failed" as const, processes: [] };
  assert.equal(
    buildResourceUsageProcessSummary([processRow(1, 1)], [pending, failed], []).samplingStatus,
    "failed",
  );
  assert.equal(
    buildResourceUsageProcessSummary(
      [processRow(1, 1)],
      [{ samplingStatus: "complete", processes: [hostRow(2, 4)] }],
      [],
    ).samplingStatus,
    "complete",
  );
});

test("Electron 缺指标或注册 Agent 不在成功进程表中时仍标记未完成", () => {
  assert.equal(
    buildResourceUsageProcessSummary([processRow(1, 0, false)], [], []).samplingStatus,
    "pending",
  );
  assert.equal(
    buildResourceUsageProcessSummary(
      [processRow(1, 1)],
      [{ samplingStatus: "complete", processes: [] }],
      [processRow(2, 0, false)],
    ).samplingStatus,
    "pending",
  );
});
