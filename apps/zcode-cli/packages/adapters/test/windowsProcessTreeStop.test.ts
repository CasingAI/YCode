// Windows 执行进程树所有权与停止（docs/specs/windows-bash-process-tree-stop.md）。
//
// 停止时 taskkill /T 只能沿当前父子链找人，root 先退出就会漏杀 reparent 的后代；
// 执行器改用 per-execution Job Object 持有整棵树：停止时 terminate，任何结算（含正常完成）
// 也必须 terminate 后 close，避免 root 已退出但后代仍被留在内核里。
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import { attachProcessToWindowsJobObject } from "../src/mcp/windows-job-object.js";
import { JOB_LAUNCHER_COMMAND, resolveJobLauncherSpawn } from "../src/exec/job-launcher-command.js";

const WINDOWS_ONLY = process.platform !== "win32";
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPidDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(25);
  }
  return !isPidAlive(pid);
}

function killExactPid(pid: number | undefined): void {
  if (pid === undefined || pid === process.pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // fixture 可能已退出。
  }
}

/** root：派生 detached 孙进程、写入 pid 文件，然后立刻退出。 */
const DELAYED_ASSIGN_ROOT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [pidFile, token] = process.argv.slice(1);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
  detached: true,
});
writeFileSync(pidFile, JSON.stringify({ token, startedAt: Date.now(), grandchildPid: grandchild.pid }));
process.exit(0);
`;

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
  "bash completion reclaims the job instead of leaving descendants behind",
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
        // 结算必须回收整棵树：只 close 不 terminate 会把 root 已退出的后代留在内核里。
        assert.deepEqual(calls, ["attach", "terminate", "close"]);
      } finally {
        await adapter.close();
      }
    });
  },
);

test("job allocation happens before the real command starts", { skip: WINDOWS_ONLY }, async () => {
  await withTempDir("zcode-job-gate-", async (outputRootDir) => {
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
        command: {
          mode: "argv",
          file: process.execPath,
          args: ["-e", "console.log('ran')"],
        },
        trace: { sessionId: "windows-job-gate-test" },
      });
      assert.equal(result.status, "completed");
      assert.equal(result.stdout.text.trim(), "ran");
      // 作业分配先于命令放行：attach 必须是第一次调用，且在 terminate/close 之前。
      assert.equal(calls[0], "attach");
    } finally {
      await adapter.close();
    }
  });
});

// 作业不可用时不放行命令：root 退出后 taskkill /T 找不到已 reparent 的后代，
// 静默运行等于对外宣称一个并不存在的整树保证。必须返回明确的 spawn_error。
test(
  "unavailable job object fails the execution instead of running the command unsafely",
  { skip: WINDOWS_ONLY },
  async () => {
    await withTempDir("zcode-job-unavailable-", async (dir) => {
      const marker = join(dir, "command-ran.txt");
      const adapter = new NodeExecutionAdapter({
        outputRootDir: join(dir, "output"),
        windowsJobObjectFactory: async () => undefined,
      });
      try {
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
          },
          timeoutMs: 20_000,
          trace: { sessionId: "windows-job-unavailable-test" },
        });
        assert.equal(result.status, "spawn_error");
        assert.match(result.error?.message ?? "", /job|process tree|ownership/i);
        const ran = await readFile(marker, "utf8").catch(() => "missing");
        assert.equal(ran, "missing");
        // 命令从未启动，预建的空输出文件也不能留下。
        const leftover = await readdir(join(dir, "output")).catch(() => [] as string[]);
        assert.deepEqual(leftover, []);
      } finally {
        await adapter.close();
      }
    });
  },
);

test(
  "launcher preserves spawn_error for a missing executable and the exit code for 127",
  { skip: WINDOWS_ONLY },
  async () => {
    await withTempDir("zcode-job-startfail-", async (dir) => {
      const adapter = new NodeExecutionAdapter({ outputRootDir: join(dir, "output") });
      try {
        // 真实命令根本没起来：必须还原成 spawn_error 和原始错误，而不是启动器退出 127。
        const missing = await adapter.run({
          command: { mode: "argv", file: join(dir, "no-such-binary.exe"), args: [] },
          trace: { sessionId: "windows-job-startfail-test" },
        });
        assert.equal(missing.status, "spawn_error");
        assert.equal(missing.error?.type, "spawn_error");
        assert.match(missing.error?.message ?? "", /ENOENT/u);

        // 命令自身以 127 退出仍然是普通失败，并保留退出码。
        const exited = await adapter.run({
          command: { mode: "argv", file: process.execPath, args: ["-e", "process.exit(127)"] },
          trace: { sessionId: "windows-job-exit127-test" },
        });
        assert.equal(exited.status, "failed");
        assert.equal(exited.exitCode, 127);
      } finally {
        await adapter.close();
      }
    });
  },
);

test(
  "launcher keeps cwd env stdin and shell semantics of the original spawn",
  { skip: WINDOWS_ONLY },
  async () => {
    await withTempDir("zcode-job-semantics-", async (dir) => {
      const adapter = new NodeExecutionAdapter({ outputRootDir: join(dir, "output") });
      try {
        const result = await adapter.run({
          command: {
            mode: "shell",
            command:
              'printf "cwd=%s\\n" "$PWD"; printf "env=%s\\n" "$ZCODE_PROBE_ENV"; ' +
              'printf "electron=%s\\n" "${ELECTRON_RUN_AS_NODE-<unset>}"; cat; exit 3',
            shellProfile: "posix-bash",
          },
          cwd: dir,
          // 启动器为自己注入 ELECTRON_RUN_AS_NODE，不能让命令看见。
          env: { set: { ZCODE_PROBE_ENV: "ok-value" } },
          stdin: "hello-stdin",
          trace: { sessionId: "windows-job-semantics-test" },
        });
        assert.equal(result.status, "failed");
        assert.equal(result.exitCode, 3);
        assert.match(result.stdout.text, /cwd=\/tmp\/|cwd=[A-Za-z]:/u);
        assert.match(result.stdout.text, /env=ok-value/u);
        assert.match(result.stdout.text, /electron=<unset>/u);
        assert.match(result.stdout.text, /hello-stdin/u);
      } finally {
        await adapter.close();
      }
    });
  },
);

// 启动器自身的 Node 选项不能泄漏进命令环境，也不能让 wrapper 把用户的预加载
// 模块跑两遍：NODE_OPTIONS 原值必须原样到目标命令，且只执行一次。
test(
  "launcher keeps user NODE_OPTIONS for the target and does not preload it twice",
  { skip: WINDOWS_ONLY },
  async () => {
    await withTempDir("zcode-job-node-options-", async (dir) => {
      const preloadMarker = join(dir, "preload.log");
      const preload = join(dir, "preload.cjs").replaceAll("\\", "/");
      const markerLiteral = JSON.stringify(preloadMarker.replaceAll("\\", "/"));
      await writeFile(preload, `require("node:fs").appendFileSync(${markerLiteral}, "x");\n`);
      const adapter = new NodeExecutionAdapter({ outputRootDir: join(dir, "output") });
      try {
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "process.stdout.write(process.env.NODE_OPTIONS ?? '<unset>')"],
          },
          env: { set: { NODE_OPTIONS: `--require ${preload}` } },
          trace: { sessionId: "windows-job-node-options-test" },
        });
        assert.equal(result.status, "completed");
        assert.equal(result.stdout.text, `--require ${preload}`);
        // 只允许目标命令执行一次预加载；wrapper 重复执行会留下两个标记。
        const marks = await readFile(preloadMarker, "utf8").catch(() => "");
        assert.equal(marks, "x");
      } finally {
        await adapter.close();
      }
    });
  },
);

// P1：作业分配晚于启动器 ready 时，真实命令不得先跑起来。
// 反例（本轮修复前）：release() 只看 gate.ready，命令在 assign 完成前就 spawn，
// 快速 root 派生 detached 孙进程后退出，作业晚到只覆盖已退出进程，孙进程成为孤儿。
test(
  "delayed job assignment gates the real command behind the assign completion",
  { skip: WINDOWS_ONLY, timeout: 30_000 },
  async () => {
    await withTempDir("zcode-job-delayed-assign-", async (dir) => {
      const pidFile = join(dir, "pids.json");
      const events: string[] = [];
      let assignCompletedAt = 0;
      const adapter = new NodeExecutionAdapter({
        outputRootDir: join(dir, "output"),
        // 真实作业 + 延迟分配：作业分配完成时间晚于启动器 ready 时，
        // 命令必须等到分配完成才放行，孙进程才会成为作业成员。
        windowsJobObjectFactory: async (pid) => {
          events.push("assign-start");
          await delay(200);
          const controller = await attachProcessToWindowsJobObject(pid);
          assignCompletedAt = Date.now();
          events.push("assign-done");
          return controller;
        },
      });
      let grandchildPid: number | undefined;
      try {
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", DELAYED_ASSIGN_ROOT, pidFile, "delayed-assign"],
          },
          timeoutMs: 20_000,
          trace: { sessionId: "windows-job-delayed-assign" },
        });
        const fixture = JSON.parse(await readFile(pidFile, "utf8")) as {
          token: string;
          startedAt: number;
          grandchildPid: number;
        };
        grandchildPid = fixture.grandchildPid;
        assert.equal(fixture.token, "delayed-assign");
        assert.equal(result.status, "completed");
        // 真实命令的启动时间必须晚于 assign 完成，而不是只比 attach 调用晚。
        assert.ok(
          fixture.startedAt >= assignCompletedAt,
          `command started at ${fixture.startedAt} before assign completed at ${assignCompletedAt}`,
        );
        const grandchildDead = await waitForPidDead(grandchildPid, 15_000);
        assert.equal(grandchildDead, true, "delayed-assign grandchild must be reclaimed");
      } finally {
        killExactPid(grandchildPid);
        await adapter.close();
      }
    });
  },
);

// P2：工厂永不 settle 时，执行与 close 都必须在启动期限内结束，不能永挂。
test(
  "job factory that never settles fails the execution instead of hanging",
  { skip: WINDOWS_ONLY, timeout: 30_000 },
  async () => {
    await withTempDir("zcode-job-stall-", async (dir) => {
      const marker = join(dir, "command-ran.txt");
      const adapter = new NodeExecutionAdapter({
        outputRootDir: join(dir, "output"),
        windowsJobObjectFactory: () => new Promise(() => undefined),
      });
      try {
        const startedAt = Date.now();
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
          },
          timeoutMs: 60_000,
          trace: { sessionId: "windows-job-stall" },
        });
        const elapsed = Date.now() - startedAt;
        assert.equal(result.status, "spawn_error");
        assert.match(result.error?.message ?? "", /job|process tree|ownership/i);
        assert.ok(
          elapsed < 20_000,
          `stalled job must fail within the startup deadline, took ${elapsed}ms`,
        );
        // 真实命令从未启动。
        const ran = await readFile(marker, "utf8").catch(() => "missing");
        assert.equal(ran, "missing");
      } finally {
        // close 也不能被永不 settle 的工厂挂住。
        const closeStartedAt = Date.now();
        await adapter.close();
        assert.ok(
          Date.now() - closeStartedAt < 20_000,
          "adapter.close must not hang on a stalled job",
        );
      }
    });
  },
);

// SEA 必须能以本二进制 + 内部命令自 re-exec；非 SEA 走 --eval，不冒充 CLI 入口。
test("job launcher self re-exec resolves for SEA and stays off the CLI entrypoint otherwise", () => {
  const sea = resolveJobLauncherSpawn({
    runtime: { execPath: "C:\\zcode.exe", isSea: true },
  });
  assert.deepEqual(sea, { command: "C:\\zcode.exe", args: [JOB_LAUNCHER_COMMAND] });

  const script = resolveJobLauncherSpawn({
    runtime: { execPath: "node.exe", isSea: false },
  });
  // 非 SEA 不能把宿主自己的 argv[1] 当 CLI 入口再跑一遍。
  assert.deepEqual(script, { command: "node.exe", args: [] });
});
