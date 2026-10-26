import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as osConstants, getPriority, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryJournalStore, type WorkflowDriver } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/harness.js";

const WINDOWS = process.platform === "win32";
const IDLE = osConstants.priority.PRIORITY_LOW;

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

/** 只读世界的 driver：保持子进程存活到测试读回优先级。 */
function createHoldingDriver(onWorldRead: () => Promise<unknown>): WorkflowDriver {
  return {
    createActorSession: () => Promise.reject(new Error("no actors in this test")),
    startAsk: () => {
      throw new Error("no ask in this test");
    },
    respondToSubmit: () => undefined,
    cancelAsk: () => undefined,
    executeWorldRead: onWorldRead,
    journal: new InMemoryJournalStore(),
    emit: () => undefined,
  };
}

test("harness 用真实子进程 PID 同步触发 onChildSpawn，宿主可据此设置 Idle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-dwf-priority-"));
  let notifiedPid: number | undefined;
  let observedPid: number | undefined;

  try {
    const settlement = await runWorkflowScript({
      cwd,
      lowered: 'const value = await __host.worldRead("site-1", "read", []);\nreturn value;',
      makeDriver: () =>
        createHoldingDriver(async () => {
          await waitFor(() => notifiedPid !== undefined);
          observedPid = notifiedPid;
          if (WINDOWS) assert.equal(getPriority(observedPid!), IDLE);
          return "held";
        }),
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
      validate: () => [],
      runId: "priority-run",
      onChildSpawn: (pid) => {
        notifiedPid = pid;
        if (WINDOWS) setPriority(pid, IDLE);
      },
    });

    assert.equal(settlement.status, "completed");
    assert.equal(settlement.status === "completed" ? settlement.artifact : undefined, "held");
    assert.ok(Number.isInteger(notifiedPid) && (notifiedPid ?? 0) > 0, "callback needs a real PID");
    assert.equal(observedPid, notifiedPid);
  } finally {
    // Windows 上被终止的子进程可能短暂占用 cwd（EBUSY），重试让句柄释放完。
    await rm(cwd, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
});

test("onChildSpawn 抛错不阻断 workflow 结算与子进程回收", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-dwf-priority-throw-"));
  let notifiedPid: number | undefined;

  try {
    const settlement = await runWorkflowScript({
      cwd,
      lowered: 'const value = await __host.worldRead("site-1", "read", []);\nreturn value;',
      makeDriver: () =>
        createHoldingDriver(async () => {
          await waitFor(() => notifiedPid !== undefined);
          return "held";
        }),
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
      validate: () => [],
      runId: "priority-throw-run",
      onChildSpawn: (pid) => {
        notifiedPid = pid;
        throw new Error("resource policy notification failed");
      },
    });

    assert.equal(settlement.status, "completed");
    assert.equal(settlement.status === "completed" ? settlement.artifact : undefined, "held");
    assert.ok(Number.isInteger(notifiedPid) && (notifiedPid ?? 0) > 0, "callback needs a real PID");
  } finally {
    if (notifiedPid !== undefined) {
      try {
        process.kill(notifiedPid);
      } catch {
        // 已由 bridge 回收。
      }
    }
    await rm(cwd, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
});

test("harness 保持 app-free：不 import 共享包、适配器或 bootstrap", async () => {
  const source = await readFile(new URL("../src/harness.ts", import.meta.url), "utf8");
  for (const dependency of [
    "@zcode/shared",
    "@zcode/adapters",
    "@zcode/bootstrap",
    "@zcode/contracts",
    "@zcode/core",
  ]) {
    const specifier = dependency.replace("/", "\\/");
    assert.equal(
      new RegExp(`from\\s+["']${specifier}["']`).test(source),
      false,
      `harness must stay free of ${dependency}`,
    );
  }
});
