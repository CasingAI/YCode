import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCliProcessPriority,
  resolveCliProcessPriority,
} from "../src/process-priority.js";
import type { ProcessPriority, ProcessPriorityResult } from "@zcode/shared/process-priority";

test("普通 Agent、TUI 和协议服务使用 Below Normal", () => {
  for (const argv of [[], ["tui"], ["app-server"], ["agent-server", "--stdio"], ["doctor"]]) {
    assert.equal(resolveCliProcessPriority(argv), "below-normal", argv.join(" "));
  }
});

test("内部搜索、插件宿主和工作流子进程使用 Idle", () => {
  assert.equal(resolveCliProcessPriority(["__internal-search", "grep", "foo"]), "idle");
  assert.equal(resolveCliProcessPriority(["__zcode-plugin-host", "server.js"]), "idle");
  assert.equal(resolveCliProcessPriority(["__zcode-dwf-child", "entry.mjs"]), "idle");
});

test("--prepare-storage 无条件跳过", () => {
  assert.equal(resolveCliProcessPriority(["app-server", "--prepare-storage"]), undefined);
  assert.equal(resolveCliProcessPriority(["--prepare-storage"]), undefined);
  assert.equal(resolveCliProcessPriority(["tui", "--prepare-storage"]), undefined);
});

test("option 值不会被误分类为开关或内部命令", () => {
  assert.equal(resolveCliProcessPriority(["--prompt=--prepare-storage"]), "below-normal");
  assert.equal(resolveCliProcessPriority(["--cwd=__internal-search"]), "below-normal");
  assert.equal(resolveCliProcessPriority(["--cwd", "__zcode-plugin-host"]), "below-normal");
});

test("applyCliProcessPriority 使用解析结果和注入的 PID", () => {
  const calls: Array<{ pid: number; priority: ProcessPriority }> = [];
  const lower = (pid: number, priority: ProcessPriority): ProcessPriorityResult => {
    calls.push({ pid, priority });
    return "applied";
  };

  assert.equal(
    applyCliProcessPriority(["tui"], { lower, pid: 4321 }),
    "applied",
  );
  assert.deepEqual(calls, [{ pid: 4321, priority: "below-normal" }]);

  assert.equal(
    applyCliProcessPriority(["__internal-search", "grep"], { lower, pid: 4321 }),
    "applied",
  );
  assert.deepEqual(calls[1], { pid: 4321, priority: "idle" });
});

test("--prepare-storage 不调用优先级接口", () => {
  let calls = 0;
  const result = applyCliProcessPriority(["app-server", "--prepare-storage"], {
    lower: () => {
      calls += 1;
      return "applied";
    },
    pid: 4321,
  });

  assert.equal(result, "skipped");
  assert.equal(calls, 0);
});

test("优先级设置失败只透传状态", () => {
  assert.equal(
    applyCliProcessPriority(["tui"], {
      lower: () => "failed",
      pid: 4321,
    }),
    "failed",
  );
});
