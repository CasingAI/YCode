import assert from "node:assert/strict";
import { constants as osConstants, getPriority } from "node:os";
import test from "node:test";
import type { FileSystemPort } from "@zcode/contracts";
import {
  readWorkflowScriptDocument,
  type WorkflowScriptDocument,
} from "../src/app/script-workflow-meta.js";
import { runScriptWorkflowChild } from "../src/app/script-workflow-process.js";

// 两条 bootstrap 显式 spawn 路径（脚本执行体、meta 求值）在 Windows 上必须把子进程根降到 Idle。
// 只观察测试自己创建的子进程：通过 ChildProcess 活动句柄定位 PID，不查询或操作任何既有进程。

const WINDOWS = process.platform === "win32";
const IDLE = osConstants.priority.PRIORITY_LOW;

interface ActiveChildHandle {
  pid?: number;
  spawnargs?: string[];
}

function childPidFor(marker: string): number | undefined {
  const handles = (
    process as unknown as { _getActiveHandles(): ActiveChildHandle[] }
  )._getActiveHandles();
  return handles.find(
    (handle) =>
      typeof handle.pid === "number" && handle.spawnargs?.some((arg) => arg.includes(marker)),
  )?.pid;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

function safePriority(pid: number): number | undefined {
  try {
    return getPriority(pid);
  } catch {
    return undefined;
  }
}

const META_SCRIPT = `export const meta = {
  name: "priority",
  description: "priority probe",
  phases: (() => {
    const end = Date.now() + 800;
    while (Date.now() < end) {}
    return [];
  })(),
};`;

test("脚本工作流子进程根降为 Idle", { skip: !WINDOWS }, async () => {
  let observedPriority: number | undefined;
  const document: WorkflowScriptDocument = {
    body: 'const value = await workflow("hold");\nreturn value;',
    content: "",
    hash: "test",
    meta: { description: "priority probe", name: "priority", phases: [] },
    path: "priority-workflow.js",
  };

  const result = await runScriptWorkflowChild({
    document,
    workingDirectory: process.cwd(),
    handleEvent: () => undefined,
    handleRequest: async () => {
      const pid = await waitFor(() => childPidFor("AsyncLocalStorage"));
      observedPriority = await waitFor(() => (safePriority(pid) === IDLE ? IDLE : undefined));
      return "held";
    },
  });

  assert.equal(result.value, "held");
  assert.equal(observedPriority, IDLE);
});

test("workflow meta 求值子进程降为 Idle", { skip: !WINDOWS }, async () => {
  const fileSystemPort = {
    readTextFile: async ({ path }: { path: string }) => ({
      bytesRead: Buffer.byteLength(META_SCRIPT),
      content: META_SCRIPT,
      encoding: "utf8",
      path,
      sizeBytes: Buffer.byteLength(META_SCRIPT),
      truncated: false,
    }),
  } as unknown as FileSystemPort;

  const documentPromise = readWorkflowScriptDocument({
    fileSystemPort,
    scriptPath: "virtual-priority-workflow.js",
    traceContext: {} as never,
  });

  const pid = await waitFor(() => childPidFor("process.stdin.setEncoding"));
  const observedPriority = await waitFor(() => (safePriority(pid) === IDLE ? IDLE : undefined));
  const document = await documentPromise;

  assert.equal(document.meta.name, "priority");
  assert.equal(observedPriority, IDLE);
});
