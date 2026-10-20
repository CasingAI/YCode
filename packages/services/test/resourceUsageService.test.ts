import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import type { ProcessResourceSample } from "../src/process/processResourceSampler.js";
import { createResourceUsageService } from "../src/process/resourceUsage/resourceUsageService.js";

/**
 * 宿主侧资源采样服务测试。
 *
 * 采样表用假数据注入：真实进程表依赖 `ps` / `/proc`，不适合单测。
 */

function sample(
  pid: number,
  ppid: number,
  rssKb: number,
  cpuPercent: number,
  command: string,
): ProcessResourceSample {
  return { pid, ppid, rssKb, cpuPercent, command };
}

function createSampler(rows: ProcessResourceSample[]) {
  return {
    sample: async () => new Map(rows.map((row) => [row.pid, row])),
  };
}

test("宿主进程树进入快照，并按基础服务 / 插件分组", async () => {
  const service = createResourceUsageService({
    hostPid: 100,
    sampler: createSampler([
      sample(100, 1, 1024, 5, "ycode-server"),
      sample(200, 100, 2048, 10, "ycode-agent"),
      sample(300, 200, 512, 1, "mcp-child"),
    ]),
    getAgentService: () => ({
      collectLocalRuntimeChildProcesses: async () => [
        {
          pid: 200,
          provider: "ycode",
          workspacePath: "/tmp/demo",
          children: [
            {
              pid: 300,
              serverName: "demo-mcp",
              mcpSource: "custom",
              pluginName: "demo",
              sessionId: "session-1",
              sessionTitle: "修复弹窗",
            },
          ],
          toolProcesses: [],
        },
      ],
    }),
  });

  const snapshot = await service.getSnapshot();
  const byPid = new Map(snapshot.processes.map((row) => [row.pid, row]));

  // 宿主自身也要有一行：桌面上由 Main 的 Electron 指标提供，Web 端没有 Main。
  assert.equal(byPid.get(100)?.groupKey, "host");
  assert.equal(byPid.get(100)?.category, "base");

  // CLI Agent 归基础服务。
  assert.equal(byPid.get(200)?.groupKey, "cli");
  assert.equal(byPid.get(200)?.category, "base");

  // MCP 子进程归社区插件，并带上来源会话。
  assert.equal(byPid.get(300)?.category, "community-plugin");
  assert.equal(byPid.get(300)?.groupLabel, "demo");
  assert.equal(byPid.get(300)?.sessionId, "session-1");
  assert.equal(byPid.get(300)?.sessionTitle, "修复弹窗");

  // 进程合计覆盖宿主自身与全部后代。
  assert.equal(snapshot.app.cpuPercent, 16);
  assert.equal(snapshot.app.memoryBytes, (1024 + 2048 + 512) * 1024);
  assert.equal(snapshot.system.memoryTotalBytes, os.totalmem());
  assert.ok(snapshot.system.memoryUsedBytes > 0);
  assert.ok(snapshot.logicalCpuCount >= 1);
});

test("进程表读取失败时仍给出整机指标", async () => {
  const service = createResourceUsageService({
    hostPid: 100,
    sampler: {
      sample: async () => {
        throw new Error("process table unavailable");
      },
    },
  });

  const snapshot = await service.getSnapshot();
  assert.deepEqual(snapshot.processes, []);
  assert.equal(snapshot.app.cpuPercent, 0);
  assert.equal(snapshot.app.memoryBytes, 0);
  assert.equal(snapshot.system.memoryTotalBytes, os.totalmem());
});

test("Agent 服务不可用时不阻断快照", async () => {
  const service = createResourceUsageService({
    hostPid: 100,
    sampler: createSampler([sample(100, 1, 1024, 4, "ycode-server")]),
    getAgentService: () => ({
      collectLocalRuntimeChildProcesses: async () => {
        throw new Error("agent unavailable");
      },
    }),
  });

  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.processes.length, 1);
  assert.equal(snapshot.app.cpuPercent, 4);
});
