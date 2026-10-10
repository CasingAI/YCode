// ============================================================
// Sandbox 阶段4测试：后台 ID、TaskOutput 窗口 console、Stop 摘后台、
// 重置旧 ID 失败、未完成后台挡回收
// ============================================================
// 验收场景 8/9/10 的单测版：显式后台拿 ID；未完成只有 console 无 return；
// filter 只返回命中行；Stop（abort 等待）后 JS 仍跑；重置后旧 ID 失败。

import assert from "node:assert/strict";
import test from "node:test";
import {
  SandboxOutputSchema,
  type SessionId,
  type ToolExecutionContext,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry, hasRunningBackgroundRuntimeTask } from "../src/runtime-task/registry.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { stopBackgroundTask } from "../src/runtime/methods/background.js";
import { getSandboxInstanceTable } from "../src/sandbox/session.js";
import { executeWithTimeout, ToolDeadline } from "../src/tool/executor/timeout.js";
import { sandboxToolEntry } from "../src/tool/handlers/sandbox.js";
import { projectTask } from "../src/tool/handlers/task-output-projection.js";

function fakeContext(sessionId: SessionId, abortSignal?: AbortSignal): ToolExecutionContext {
  return {
    toolCallId: "call_sandbox_bg_1",
    abortSignal: abortSignal ?? new AbortController().signal,
    sessionId,
    workingDirectory: "/work",
    workspaceRoot: "/work",
  } as unknown as ToolExecutionContext;
}

function fakeProjectContext(sessionId: SessionId): ToolExecutionContext {
  return {
    toolCallId: "call_task_output_1",
    abortSignal: new AbortController().signal,
    sessionId,
    workingDirectory: "/work",
    workspaceRoot: "/work",
  } as unknown as ToolExecutionContext;
}

function freshSession(prefix: string): SessionId {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}` as SessionId;
}

test("显式后台：返回 backgrounded + sandbox_ 前缀 ID，后台态文案带 ID 与 TaskOutput 指引", async () => {
  const sessionId = freshSession("sess_sandbox_bg_explicit");
  try {
    const output = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler(
        { description: "后台算一下", code: "return 1+1;", runInBackground: true },
        fakeContext(sessionId),
      ),
    );
    assert.equal(output.status, "backgrounded");
    assert.ok(output.backgroundTaskId?.startsWith("sandbox_"));
    const text = sandboxToolEntry.formatModelContent?.(output) ?? "";
    assert.ok(text.includes(output.backgroundTaskId as string));
    assert.ok(text.includes("TaskOutput"));
    // 后台结算：等终态后实例表的快照为 completed。
    const settled = await getSandboxInstanceTable().waitForBackgroundEval(
      output.backgroundTaskId as string,
    );
    assert.equal(settled?.status, "completed");
    assert.equal(settled?.returnText, "2");
  } finally {
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("未完成时 TaskOutput 只有窗口 console、无 return；完成时带 return", async () => {
  const sessionId = freshSession("sess_sandbox_bg_window");
  const registry = new InMemoryRuntimeTaskRegistry();
  try {
    const output = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler(
        {
          description: "慢任务",
          code: 'console.log("hello-bg"); await new Promise((r) => setTimeout(r, 300)); return "done-bg";',
          runInBackground: true,
        },
        fakeContext(sessionId),
      ),
    );
    const taskId = output.backgroundTaskId as string;
    registry.register({
      taskId,
      agentId: taskId,
      agentType: "local_sandbox",
      description: "Sandbox background evaluation",
      isBackgrounded: true,
      startedAt: new Date(),
      status: "running",
      taskType: "local_sandbox",
      type: "local_sandbox",
    });
    // 未完成投影：有 console、无 result（return）。
    const running = await projectTask(registry.get(taskId)!, fakeProjectContext(sessionId));
    assert.equal(running.status, "running");
    assert.ok(running.output.includes("hello-bg"));
    assert.equal((running as { result?: string }).result, undefined);
    // 完成后投影：console + return 都在。
    const settled = await getSandboxInstanceTable().waitForBackgroundEval(taskId);
    assert.equal(settled?.status, "completed");
    registry.update(taskId, (current) => ({ ...current, status: "completed", completedAt: new Date() }));
    const done = await projectTask(registry.get(taskId)!, fakeProjectContext(sessionId));
    assert.equal(done.status, "completed");
    assert.ok(done.output.includes("hello-bg"));
    assert.ok(done.output.includes("done-bg"));
    assert.equal((done as { result?: string }).result, "done-bg");
  } finally {
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("consoleFilter 只返回命中行", async () => {
  const sessionId = freshSession("sess_sandbox_bg_filter");
  const registry = new InMemoryRuntimeTaskRegistry();
  try {
    const output = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler(
        {
          description: "多行日志",
          code: 'console.log("apple one"); console.log("banana two"); return "ok";',
          runInBackground: true,
        },
        fakeContext(sessionId),
      ),
    );
    const taskId = output.backgroundTaskId as string;
    registry.register({
      taskId,
      agentId: taskId,
      agentType: "local_sandbox",
      description: "Sandbox background evaluation",
      isBackgrounded: true,
      startedAt: new Date(),
      status: "running",
      taskType: "local_sandbox",
      type: "local_sandbox",
    });
    await getSandboxInstanceTable().waitForBackgroundEval(taskId);
    registry.update(taskId, (current) => ({ ...current, status: "completed", completedAt: new Date() }));
    const filtered = await projectTask(registry.get(taskId)!, fakeProjectContext(sessionId), {
      consoleFilter: "banana",
    });
    assert.ok(filtered.output.includes("banana two"));
    assert.ok(!filtered.output.includes("apple one"));
    // return 不受 filter 影响，仍带上。
    assert.equal((filtered as { result?: string }).result, "ok");
  } finally {
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("前台 Stop（abort 等待）摘后台：JS 继续跑，console 仍进环", async () => {
  const sessionId = freshSession("sess_sandbox_bg_stop");
  const controller = new AbortController();
  try {
    // 前台调用 50ms 即 abort：摘的是等待，不是 JS。
    const pending = sandboxToolEntry.handler(
      {
        description: "停不下来的任务",
        code: 'console.log("before-abort"); await new Promise((r) => setTimeout(r, 400)); console.log("after-abort"); return "late";',
        timeout: 60_000,
      },
      fakeContext(sessionId, controller.signal),
    );
    setTimeout(() => controller.abort(), 50);
    const output = SandboxOutputSchema.parse(await pending);
    assert.equal(output.status, "backgrounded");
    const taskId = output.backgroundTaskId as string;
    // JS 继续：等终态后 after-abort 已进环，return 也结算。
    const settled = await getSandboxInstanceTable().waitForBackgroundEval(taskId);
    assert.equal(settled?.status, "completed");
    assert.equal(settled?.returnText, "late");
    const window = getSandboxInstanceTable().readConsoleWindowForBackground(taskId, {});
    const text = window.consoleLines.map((line) => line.text).join("\n");
    assert.ok(text.includes("before-abort"));
    assert.ok(text.includes("after-abort"));
  } finally {
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("重置后旧 ID 读失败（error），LocalStorage 提示仍在", async () => {
  const sessionId = freshSession("sess_sandbox_bg_reset");
  const registry = new InMemoryRuntimeTaskRegistry();
  try {
    const output = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler(
        { description: "后台任务", code: "return 1;", runInBackground: true },
        fakeContext(sessionId),
      ),
    );
    const taskId = output.backgroundTaskId as string;
    registry.register({
      taskId,
      agentId: taskId,
      agentType: "local_sandbox",
      description: "Sandbox background evaluation",
      isBackgrounded: true,
      startedAt: new Date(),
      status: "running",
      taskType: "local_sandbox",
      type: "local_sandbox",
    });
    await getSandboxInstanceTable().waitForBackgroundEval(taskId);
    // 重置销毁实例：旧 ID 失效。
    await getSandboxInstanceTable().reset(sessionId);
    const projected = await projectTask(registry.get(taskId)!, fakeProjectContext(sessionId));
    assert.ok(projected.error);
    assert.ok(projected.error.includes("已销毁"));
  } finally {
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("未完成沙盒后台挡回收：running 计入，结算后不再挡", async () => {
  const sessionId = freshSession("sess_sandbox_bg_residency");
  const registry = new InMemoryRuntimeTaskRegistry();
  try {
    const output = SandboxOutputSchema.parse(
      await sandboxToolEntry.handler(
        {
          description: "挡回收的任务",
          code: 'await new Promise((r) => setTimeout(r, 200)); return "ok";',
          runInBackground: true,
        },
        fakeContext(sessionId),
      ),
    );
    const taskId = output.backgroundTaskId as string;
    registry.register({
      taskId,
      agentId: taskId,
      agentType: "local_sandbox",
      description: "Sandbox background evaluation",
      isBackgrounded: true,
      startedAt: new Date(),
      status: "running",
      taskType: "local_sandbox",
      type: "local_sandbox",
    });
    // 未完成：挡回收（与 Bash 后台同一口径）。
    assert.equal(hasRunningBackgroundRuntimeTask(registry), true);
    await getSandboxInstanceTable().waitForBackgroundEval(taskId);
    registry.update(taskId, (current) => ({ ...current, status: "completed", completedAt: new Date() }));
    assert.equal(hasRunningBackgroundRuntimeTask(registry), false);
  } finally {
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("执行器级停止：executeWithTimeout + abort 仍交回 backgrounded（joinOnCancel）", async () => {
  const sessionId = freshSession("sess_sandbox_bg_exec_stop");
  const registry = new InMemoryRuntimeTaskRegistry();
  // 原因与修复依据：无 joinOnCancel 时执行器抢先 reject ToolCancelled，handler 交回的
  // backgrounded 被丢弃（无后台 ID、无登记、无 residency 挡回收）。本用例走真实
  // executeWithTimeout，断言 abort 后仍拿到 backgrounded + sandbox_ ID。
  const executionAbortController = new AbortController();
  const deadline = new ToolDeadline(60_000);
  try {
    const pending = executeWithTimeout(
      sandboxToolEntry.handler,
      {
        description: "执行器级停止探针",
        code: 'console.log("exec-before-abort"); await new Promise((r) => setTimeout(r, 400)); console.log("exec-after-abort"); return "exec-late";',
        timeout: 60_000,
      },
      fakeContext(sessionId, executionAbortController.signal),
      deadline,
      executionAbortController,
      sandboxToolEntry,
    );
    setTimeout(() => executionAbortController.abort(), 50);
    const output = SandboxOutputSchema.parse(await pending);
    assert.equal(output.status, "backgrounded");
    assert.ok(output.backgroundTaskId?.startsWith("sandbox_"));
    const taskId = output.backgroundTaskId as string;
    // 该输出即 call-runner 传给 trackBackgroundTask 的形状（status=backgrounded 触发登记）：
    // 登记 running 后 residency 必须挡回收。
    registry.register({
      taskId,
      agentId: taskId,
      agentType: "local_sandbox",
      description: "Sandbox background evaluation",
      isBackgrounded: true,
      startedAt: new Date(),
      status: "running",
      taskType: "local_sandbox",
      type: "local_sandbox",
    });
    assert.equal(hasRunningBackgroundRuntimeTask(registry), true);
    // JS 继续：等终态后 return 结算，console 两行都在。
    const settled = await getSandboxInstanceTable().waitForBackgroundEval(taskId);
    assert.equal(settled?.status, "completed");
    assert.equal(settled?.returnText, "exec-late");
    const window = getSandboxInstanceTable().readConsoleWindowForBackground(taskId, {});
    const text = window.consoleLines.map((line) => line.text).join("\n");
    assert.ok(text.includes("exec-before-abort"));
    assert.ok(text.includes("exec-after-abort"));
    registry.update(taskId, (current) => ({ ...current, status: "completed", completedAt: new Date() }));
    assert.equal(hasRunningBackgroundRuntimeTask(registry), false);
  } finally {
    deadline.clear();
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("执行器级超时：墙钟 deadline 到期仍交回 backgrounded，而非超时失败", async () => {
  const sessionId = freshSession("sess_sandbox_bg_exec_timeout");
  const executionAbortController = new AbortController();
  // 墙钟 50ms 到期 abort；handler 输入超时给 60s，保证先到期的是执行器 deadline。
  const deadline = new ToolDeadline(50);
  try {
    const output = SandboxOutputSchema.parse(
      await executeWithTimeout(
        sandboxToolEntry.handler,
        {
          description: "执行器级超时探针",
          code: 'console.log("timeout-before"); await new Promise((r) => setTimeout(r, 400)); console.log("timeout-after"); return "timeout-late";',
          timeout: 60_000,
        },
        fakeContext(sessionId, executionAbortController.signal),
        deadline,
        executionAbortController,
        sandboxToolEntry,
      ),
    );
    // 无 joinOnCancel 时这里会抛 ToolTimeout；有则摘后台。
    assert.equal(output.status, "backgrounded");
    assert.ok(output.backgroundTaskId?.startsWith("sandbox_"));
    const taskId = output.backgroundTaskId as string;
    const settled = await getSandboxInstanceTable().waitForBackgroundEval(taskId);
    assert.equal(settled?.status, "completed");
    assert.equal(settled?.returnText, "timeout-late");
  } finally {
    deadline.clear();
    getSandboxInstanceTable().dispose(sessionId);
  }
});

test("停止沙盒后台被显式拒绝：不打断 JS，只能重置实例", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const taskId = "sandbox_unit_stop_probe";
  registry.register({
    taskId,
    agentId: taskId,
    agentType: "local_sandbox",
    description: "Sandbox background evaluation",
    isBackgrounded: true,
    startedAt: new Date(),
    status: "running",
    taskType: "local_sandbox",
    type: "local_sandbox",
  });
  // 最小 runtime stub：stopBackgroundTask 只读 registry + 投影；投影侧无该任务时
  // 回落到 registry 条目，足以走到 local_sandbox 显式分支。
  const runtime = {
    rootTraceContext: undefined,
    runtimeTaskRegistry: registry,
    rebuildProjection: async () => ({ backgroundTasks: [] }),
  } as unknown as AgentRuntimeInternal;
  const result = await stopBackgroundTask.call(runtime, taskId, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  // 原因与修复依据：沙盒后台没有「停这一条 JS」（spec「停止与重置」：停止从不打断
  // 正在跑的 JS，可靠的整段停法只有销毁实例），显式分支钉死该不变量。
  assert.equal(result.reason, "background_task_cancel_not_supported");
  assert.equal(result.type, "local_sandbox");
});
