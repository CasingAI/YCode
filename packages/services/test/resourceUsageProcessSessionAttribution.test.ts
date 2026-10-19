import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeHostProcessTree,
  type HostResourceUsageAgent,
} from "../src/process/hostProcessAttribution.js";
import type { ProcessResourceSample } from "../src/process/processResourceSampler.js";

// 资源管理器的“来自哪个会话”归属（docs/specs/resource-manager-process-session-attribution.md）：
// 工具派生进程根与独占的 MCP 连接带会话，整棵子树继承该会话；
// 多会话共享的进程不带会话，避免把共享进程说成某个会话独占。

const HOST_PID = 100;

function sample(pid: number, ppid: number, command: string): ProcessResourceSample {
  return { pid, ppid, rssKb: 1024, cpuPercent: 1, command };
}

function agent(overrides: Partial<HostResourceUsageAgent> = {}): HostResourceUsageAgent {
  return {
    pid: 200,
    provider: "glm",
    workspacePath: "/repo/YCode",
    children: [],
    toolProcesses: [],
    ...overrides,
  };
}

test("工具派生进程根及其后代都归属到发起执行的会话", () => {
  const samples = new Map<number, ProcessResourceSample>([
    [HOST_PID, sample(HOST_PID, 1, "ycode-host")],
    [200, sample(200, HOST_PID, "ycode-cli")],
    [300, sample(300, 200, "/bin/zsh")],
    [301, sample(301, 300, "/usr/local/bin/node")],
    [302, sample(302, 301, "/usr/local/bin/node")],
  ]);

  const rows = attributeHostProcessTree({
    samples,
    hostPid: HOST_PID,
    agents: [
      agent({
        toolProcesses: [{ pid: 300, sessionId: "sess-1", sessionTitle: "修复弹窗" }],
      }),
    ],
  });

  const byPid = new Map(rows.map((row) => [row.pid, row]));
  assert.equal(byPid.get(300)?.sessionId, "sess-1");
  assert.equal(byPid.get(300)?.sessionTitle, "修复弹窗");
  // 后代沿进程树继承会话归属。
  assert.equal(byPid.get(301)?.sessionId, "sess-1");
  assert.equal(byPid.get(302)?.sessionId, "sess-1");
  // Agent runtime 本身服务多个会话，不能被标成某个会话独占。
  assert.equal(byPid.get(200)?.sessionId, undefined);
});

test("MCP 独占连接带会话，后代继承；共享连接不带会话", () => {
  const samples = new Map<number, ProcessResourceSample>([
    [HOST_PID, sample(HOST_PID, 1, "ycode-host")],
    [200, sample(200, HOST_PID, "ycode-cli")],
    [400, sample(400, 200, "ycode-node-repl-mcp")],
    [401, sample(401, 400, "/usr/local/bin/node")],
    [402, sample(402, 200, "ycode-node-repl-mcp")],
  ]);

  const rows = attributeHostProcessTree({
    samples,
    hostPid: HOST_PID,
    agents: [
      agent({
        children: [
          {
            pid: 400,
            serverName: "node_repl",
            mcpSource: "builtin",
            sessionId: "sess-2",
            sessionTitle: "会话二",
          },
          { pid: 402, serverName: "node_repl", mcpSource: "builtin" },
        ],
      }),
    ],
  });

  const byPid = new Map(rows.map((row) => [row.pid, row]));
  assert.equal(byPid.get(400)?.sessionId, "sess-2");
  assert.equal(byPid.get(400)?.sessionTitle, "会话二");
  assert.equal(byPid.get(401)?.sessionId, "sess-2");
  assert.equal(byPid.get(402)?.sessionId, undefined);
});

test("没有会话信息时进程行不携带会话字段", () => {
  const samples = new Map<number, ProcessResourceSample>([
    [HOST_PID, sample(HOST_PID, 1, "ycode-host")],
    [200, sample(200, HOST_PID, "ycode-cli")],
    [300, sample(300, 200, "/usr/local/bin/node")],
  ]);

  const rows = attributeHostProcessTree({ samples, hostPid: HOST_PID, agents: [agent()] });

  for (const row of rows) {
    assert.equal(row.sessionId, undefined);
    assert.equal(row.sessionTitle, undefined);
  }
});
