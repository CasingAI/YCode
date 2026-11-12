// Windows Bash 进程树停止（docs/specs/windows-bash-process-tree-stop.md）。
//
// 停止时 taskkill /T 只能沿当前父子链找人，root 先退出就会漏杀 reparent 的后代；
// 这里验证执行器改用 Job Object 成员身份回收整棵树，并且正常完成不误杀命令
// 自己放到后台的进程。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import { attachProcessToWindowsJobObject } from "../src/mcp/windows-job-object.js";

const WINDOWS_ONLY = process.platform !== "win32";
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function createFakeJobApi(assignResult = true) {
  const created: number[] = [];
  const calls: string[] = [];
  const api = {
    create(limitFlags: number) {
      created.push(limitFlags);
      calls.push(`create:${limitFlags}`);
      return {} as object;
    },
    assign() {
      calls.push("assign");
      return assignResult;
    },
    terminate() {
      calls.push("terminate");
    },
    close() {
      calls.push("close");
    },
  };
  return { api, calls, created };
}

test("job object defaults to kill-on-close and can opt out", async () => {
  const defaults = createFakeJobApi();
  const controller = await attachProcessToWindowsJobObject(1234, {
    api: defaults.api,
    platform: "win32",
  });
  assert.ok(controller);
  assert.deepEqual(defaults.created, [JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE]);

  const bash = createFakeJobApi();
  const bashController = await attachProcessToWindowsJobObject(1234, {
    api: bash.api,
    platform: "win32",
    killOnJobClose: false,
  });
  assert.ok(bashController);
  assert.deepEqual(bash.created, [0]);
});

test("job object closes the handle when assignment fails", async () => {
  const fake = createFakeJobApi(false);
  const controller = await attachProcessToWindowsJobObject(1234, {
    api: fake.api,
    platform: "win32",
  });
  assert.equal(controller, undefined);
  assert.deepEqual(fake.calls, ["create:8192", "assign", "close"]);
});

test("job object terminate and close are idempotent", async () => {
  const fake = createFakeJobApi();
  const controller = await attachProcessToWindowsJobObject(1234, {
    api: fake.api,
    platform: "win32",
  });
  assert.ok(controller);
  controller.terminate();
  controller.terminate();
  controller.close();
  controller.close();
  assert.deepEqual(fake.calls, ["create:8192", "assign", "terminate", "close"]);
});

test(
  "bash stop terminates the windows job instead of only the root",
  { skip: WINDOWS_ONLY },
  async () => {
    await withTempDir("zcode-job-stop-", async (outputRootDir) => {
      const calls: string[] = [];
      const adapter = new NodeExecutionAdapter({
        outputRootDir,
        windowsJobObjectFactory: async () => {
          calls.push("attach");
          return {
            terminate: () => calls.push("terminate"),
            close: () => calls.push("close"),
          };
        },
      });
      let started: () => void = () => undefined;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      try {
        const task = await adapter.start(
          {
            command: {
              mode: "argv",
              file: process.execPath,
              args: ["-e", "setTimeout(() => {}, 60000)"],
            },
            trace: { sessionId: "windows-job-stop-test" },
          },
          {
            onEvent: (event) => {
              if (event.type === "started") started();
            },
          },
        );
        await startedPromise;
        await adapter.cancelBackgroundTask(task.taskId);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, ["attach", "terminate", "close"]);
      } finally {
        await adapter.close();
      }
    });
  },
);

test(
  "bash completion closes the job without terminating backgrounded descendants",
  { skip: WINDOWS_ONLY },
  async () => {
    await withTempDir("zcode-job-complete-", async (outputRootDir) => {
      const calls: string[] = [];
      const adapter = new NodeExecutionAdapter({
        outputRootDir,
        windowsJobObjectFactory: async () => {
          calls.push("attach");
          return {
            terminate: () => calls.push("terminate"),
            close: () => calls.push("close"),
          };
        },
      });
      try {
        const result = await adapter.run({
          command: { mode: "argv", file: process.execPath, args: ["-e", "process.exit(0)"] },
          trace: { sessionId: "windows-job-complete-test" },
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(result.status, "completed");
        assert.deepEqual(calls, ["attach", "close"]);
      } finally {
        await adapter.close();
      }
    });
  },
);
