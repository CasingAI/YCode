import assert from "node:assert/strict";
import test from "node:test";
import { listChildProcesses } from "../src/zcode-protocol/process-child-processes.js";

// `process/childProcesses` 的会话归属（docs/specs/resource-manager-process-session-attribution.md）：
// MCP 连接只有在单一会话独占时才带会话；工具派生进程根带上发起该次执行的会话。

test("独占会话的 MCP 进程带上会话与标题", async () => {
  const result = await listChildProcesses(
    [
      {
        pid: 501,
        serverName: "node_repl",
        mcpSource: "builtin",
        sessionIds: ["sess-1"],
      },
    ],
    [],
    async (sessionId) => (sessionId === "sess-1" ? "修复弹窗" : undefined),
  );

  assert.equal(result.processes[0]?.sessionId, "sess-1");
  assert.equal(result.processes[0]?.sessionTitle, "修复弹窗");
});

test("多会话共享的 MCP 连接不带会话", async () => {
  const result = await listChildProcesses(
    [
      {
        pid: 502,
        serverName: "node_repl",
        mcpSource: "builtin",
        sessionIds: ["sess-1", "sess-2"],
      },
    ],
    [],
    async () => "标题",
  );

  assert.equal(result.processes[0]?.sessionId, undefined);
  assert.equal(result.processes[0]?.sessionTitle, undefined);
});

test("工具派生进程根带会话与标题", async () => {
  const result = await listChildProcesses(
    [],
    [{ pid: 601, sessionId: "sess-3" }],
    async (sessionId) => (sessionId === "sess-3" ? "跑测试" : undefined),
  );

  assert.deepEqual(result.toolProcesses, [
    { pid: 601, sessionId: "sess-3", sessionTitle: "跑测试" },
  ]);
});

test("没有工具进程时省略 toolProcesses 字段", async () => {
  const result = await listChildProcesses([], []);
  assert.equal(result.toolProcesses, undefined);
});
