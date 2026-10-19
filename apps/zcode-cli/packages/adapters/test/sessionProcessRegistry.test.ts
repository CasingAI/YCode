import assert from "node:assert/strict";
import test from "node:test";
import {
  listSessionProcesses,
  registerSessionProcess,
  resetSessionProcessRegistry,
  unregisterSessionProcess,
} from "../src/exec/session-process-registry.js";

// 工具派生进程 → 会话登记簿：资源管理器据此标注“来自哪个会话”。
// 登记只认工具派生的根 pid，孙进程由 Host 的进程树继承。

test("登记与注销工具派生进程根", () => {
  resetSessionProcessRegistry();
  registerSessionProcess(4242, "sess-1");
  assert.deepEqual(listSessionProcesses(), [{ pid: 4242, sessionId: "sess-1" }]);

  unregisterSessionProcess(4242);
  assert.deepEqual(listSessionProcesses(), []);
});

test("非法 pid 与空会话 id 不登记", () => {
  resetSessionProcessRegistry();
  registerSessionProcess(0, "sess-1");
  registerSessionProcess(-1, "sess-1");
  registerSessionProcess(12, "   ");
  registerSessionProcess(12, undefined);
  assert.deepEqual(listSessionProcesses(), []);
});

test("同一 pid 重新登记时以最新会话为准", () => {
  resetSessionProcessRegistry();
  registerSessionProcess(7, "sess-old");
  registerSessionProcess(7, "sess-new");
  assert.deepEqual(listSessionProcesses(), [{ pid: 7, sessionId: "sess-new" }]);
});
