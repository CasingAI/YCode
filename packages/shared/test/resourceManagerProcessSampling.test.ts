import assert from "node:assert/strict";
import test from "node:test";
import {
  hostResourceUsageSnapshotResultResponseSchema,
  type HostResourceUsageSnapshotResultResponse,
} from "../src/validation.js";

/**
 * 资源管理器 Host 回帖的严格 schema（docs/specs/resource-manager-process-sampling.md）。
 *
 * 会话字段只是展示信息：带 sessionId/sessionTitle 的后代进程很常见，
 * strict schema 必须接受这两个可选字段，否则 Main 会拒绝整份快照。
 * 除此之外仍保持严格校验，不能因兼容会话信息而开放任意未知字段。
 */

function hostResponse(
  overrides: Partial<HostResourceUsageSnapshotResultResponse> = {},
): HostResourceUsageSnapshotResultResponse {
  return {
    type: "resource-usage-snapshot-result",
    requestId: "req-1",
    sampledAt: 1_700_000_000_000,
    processes: [
      {
        pid: 301,
        name: "node",
        category: "base",
        groupKey: "cli",
        groupLabel: "cli",
        cpuPercent: 1.5,
        memoryBytes: 1024,
      },
    ],
    ...overrides,
  };
}

test("Host 回帖接受可选的会话字段", () => {
  const parsed = hostResourceUsageSnapshotResultResponseSchema.parse(
    hostResponse({
      processes: [
        {
          pid: 301,
          name: "node",
          category: "base",
          groupKey: "cli",
          groupLabel: "cli",
          cpuPercent: 1.5,
          memoryBytes: 1024,
          sessionId: "sess-1",
          sessionTitle: "修复资源管理器",
        },
      ],
    }),
  );

  assert.equal(parsed.processes[0]?.sessionId, "sess-1");
  assert.equal(parsed.processes[0]?.sessionTitle, "修复资源管理器");
});

test("Host 回帖接受与协议一致的长会话标题，不因长度拒绝整份快照", () => {
  const longTitle = "长".repeat(600);
  const parsed = hostResourceUsageSnapshotResultResponseSchema.parse(
    hostResponse({
      processes: [
        {
          pid: 301,
          name: "node",
          category: "base",
          groupKey: "cli",
          groupLabel: "cli",
          cpuPercent: 1.5,
          memoryBytes: 1024,
          sessionId: "sess-long",
          sessionTitle: longTitle,
        },
      ],
    }),
  );

  assert.equal(parsed.processes[0]?.sessionTitle, longTitle);
});

test("Host 回帖缺省 samplingStatus 兼容旧宿主，也接受显式 failed", () => {
  const legacy = hostResourceUsageSnapshotResultResponseSchema.parse(hostResponse());
  assert.equal(legacy.samplingStatus, undefined);

  const failed = hostResourceUsageSnapshotResultResponseSchema.parse(
    hostResponse({ processes: [], samplingStatus: "failed" }),
  );
  assert.equal(failed.samplingStatus, "failed");

  const complete = hostResourceUsageSnapshotResultResponseSchema.parse(
    hostResponse({ samplingStatus: "complete" }),
  );
  assert.equal(complete.samplingStatus, "complete");
});

test("Host 回帖仍拒绝未知字段和非法 samplingStatus", () => {
  assert.throws(() =>
    hostResourceUsageSnapshotResultResponseSchema.parse({
      ...hostResponse(),
      unexpected: true,
    }),
  );
  assert.throws(() =>
    hostResourceUsageSnapshotResultResponseSchema.parse(
      hostResponse({ samplingStatus: "pending" as never }),
    ),
  );
  assert.throws(() =>
    hostResourceUsageSnapshotResultResponseSchema.parse(
      hostResponse({
        processes: [
          {
            pid: 301,
            name: "node",
            category: "base",
            groupKey: "cli",
            groupLabel: "cli",
            cpuPercent: 1,
            memoryBytes: 1024,
            unknownProcessField: true,
          } as never,
        ],
      }),
    ),
  );
});
