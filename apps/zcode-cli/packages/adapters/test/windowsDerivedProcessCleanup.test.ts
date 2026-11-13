// Windows 派生进程自动清理的真实进程回归。
//
// 产品裁定（docs/specs/windows-bash-process-tree-stop.md 更新中）：
// - 每个 execution 持有一棵整树；前台与正式后台任务都要在任务结算时回收未被接管的后代。
// - run_in_background / auto_on_timeout 只在任务仍 active 时保留，root 退出且任务 completed 后不得残留。
// - Windows 使用 per-execution kill-on-close Job，主实现负责 spawn 前就绪屏障，测试不注入
//   windowsJobObjectFactory，也不人为等待 Job ready 来掩盖 attach 竞态。
//
// 安全约束：只 spawn 本测试自己的 fixture，记录唯一 token 与精确 PID；finally 按精确 PID 回收。
// 不使用进程名 kill、全局 taskkill，也不把测试自身放进 kill-on-close Job。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionId, TraceContext, TraceId } from "@zcode/contracts";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";

const WINDOWS_ONLY = process.platform !== "win32";
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const ADAPTER_MODULE_URL = new URL("../src/exec/node-execution-adapter.ts", import.meta.url).href;
const PID_WAIT_MS = 15_000;
const DEATH_WAIT_MS = 15_000;

interface FixturePids {
  readonly rootPid: number;
  readonly grandchildPid: number;
  readonly token: string;
}

interface PidTracker {
  remember(pid: number | undefined): void;
  cleanup(): Promise<number[]>;
}

const ROOT_SCRIPT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile, token, mode] = process.argv.slice(2);
// 非 detached 的 Node 子进程会随 root 的 libuv 作业句柄关闭而消失，掩盖真实的
// reparent/orphan 场景；这里让孙进程脱离 root 自己的作业，只由 adapter 的
// per-execution Job 负责回收。
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
  detached: true,
});
writeFileSync(
  pidFile,
  JSON.stringify({ rootPid: process.pid, grandchildPid: grandchild.pid, token }),
);
if (mode === "hold") {
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
`;

// manager 自己运行 adapter；测试只按精确 PID 杀掉这个 fixture manager。
const MANAGER_SCRIPT = `
import { writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";

// libuv 会给非 detached 子进程建 kill-on-close 作业，manager 被杀时会先于 adapter
// 的 Job 杀树，掩盖 adapter 自身的 owner 语义。fixture 让 root 脱离 manager 的
// libuv 作业，只由 adapter 的 per-execution Job 负责回收。
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const defaultSpawn = childProcess.spawn;
childProcess.spawn = (file, args, options) =>
  defaultSpawn(file, args, { ...options, detached: true });
syncBuiltinESMExports();

const { NodeExecutionAdapter } = await import(process.env.ADAPTER_MODULE_URL);
const [rootScript, pidFile, readyFile, token, outputRootDir] = process.argv.slice(2);
const adapter = new NodeExecutionAdapter({ outputRootDir });
const task = await adapter.start({
  command: {
    mode: "argv",
    file: process.execPath,
    args: [rootScript, pidFile, token, "hold"],
  },
  trace: { sessionId: "windows-derived-owner-crash" },
});
await writeFile(readyFile, JSON.stringify({ taskId: task.taskId, token }));
setInterval(() => {}, 1000);
`;

const FAST_EXIT_ROOT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [pidFile, token] = process.argv.slice(1);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
  detached: true,
});
writeFileSync(pidFile, JSON.stringify({ rootPid: process.pid, grandchildPid: grandchild.pid, token }));
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
    // Windows 上对仍有句柄但无权限的进程可能返回 EPERM；那仍表示进程存在。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killExactPid(pid: number): void {
  if (pid === process.pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // fixture 可能已自行退出；清理必须幂等。
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

function createPidTracker(): PidTracker {
  const pids = new Set<number>();
  return {
    remember(pid) {
      if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
      pids.add(pid);
    },
    async cleanup() {
      const list = Array.from(pids);
      for (const pid of list) killExactPid(pid);
      await Promise.all(list.map((pid) => waitForPidDead(pid, 5_000)));
      pids.clear();
      return list;
    },
  };
}

async function waitForFile(path: string, timeoutMs: number, label: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(`${label} was not written before timeout: ${String(lastError)}`);
}

async function readFixturePids(
  pidFile: string,
  token: string,
  timeoutMs: number,
): Promise<FixturePids> {
  const text = await waitForFile(pidFile, timeoutMs, "fixture pid file");
  const parsed = JSON.parse(text) as Partial<FixturePids>;
  assert.equal(parsed.token, token, "fixture pid file token must match this test");
  assert.ok(
    Number.isInteger(parsed.rootPid) && (parsed.rootPid as number) > 0,
    "fixture root pid must be positive",
  );
  assert.ok(
    Number.isInteger(parsed.grandchildPid) && (parsed.grandchildPid as number) > 0,
    "fixture grandchild pid must be positive",
  );
  return parsed as FixturePids;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function closeAdapter(adapter: NodeExecutionAdapter, label: string): Promise<void> {
  await withTimeout(adapter.close(), 15_000, label);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`child ${child.pid ?? "unknown"} did not exit after ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

function shellQuote(value: string): string {
  if (/["\r\n]/u.test(value)) {
    throw new Error(`fixture path cannot be safely shell-quoted: ${value}`);
  }
  return `"${value}"`;
}

async function writeRootScript(dir: string): Promise<string> {
  const path = join(dir, "root.mjs");
  await writeFile(path, ROOT_SCRIPT, "utf8");
  return path;
}

async function writeManagerScript(dir: string): Promise<string> {
  const path = join(dir, "manager.mjs");
  await writeFile(path, MANAGER_SCRIPT, "utf8");
  return path;
}

function makeAdapter(dir: string): NodeExecutionAdapter {
  return new NodeExecutionAdapter({ outputRootDir: join(dir, "output") });
}

function traceContext(name: string, token: string): TraceContext {
  return {
    traceId: randomUUID() as TraceId,
    sessionId: `windows-derived-${name}-${token}` as SessionId,
  };
}

async function startExplicitBackground(
  adapter: NodeExecutionAdapter,
  rootScript: string,
  pidFile: string,
  token: string,
  mode: "hold" | "exit",
  name: string,
): Promise<{ taskId: string; pid?: number }> {
  const command = [
    shellQuote(process.execPath),
    shellQuote(rootScript),
    shellQuote(pidFile),
    shellQuote(token),
    shellQuote(mode),
  ].join(" ");
  const outcome = await adapter.runBashWithBackgroundLifecycle(
    {
      command: { mode: "shell", command, shellProfile: "posix-bash" },
      timeoutMs: 30_000,
      trace: traceContext(name, token),
    },
    { mode: "explicit" },
  );
  assert.equal(outcome.kind, "backgrounded", "explicit background must commit immediately");
  return { taskId: outcome.task.taskId, pid: outcome.task.pid };
}

test(
  "foreground normal completion removes an unadopted grandchild",
  { skip: WINDOWS_ONLY, timeout: 35_000 },
  async (t) => {
    await withTempDir("zcode-derived-foreground-", async (dir) => {
      const token = randomUUID();
      const rootScript = await writeRootScript(dir);
      const pidFile = join(dir, "pids.json");
      const adapter = makeAdapter(dir);
      const tracker = createPidTracker();
      let pids: FixturePids | undefined;
      try {
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: [rootScript, pidFile, token, "exit"],
          },
          timeoutMs: 20_000,
          trace: traceContext("foreground", token),
        });
        pids = await readFixturePids(pidFile, token, PID_WAIT_MS);
        tracker.remember(pids.rootPid);
        tracker.remember(pids.grandchildPid);
        assert.equal(result.status, "completed");

        const grandchildDead = await waitForPidDead(pids.grandchildPid, DEATH_WAIT_MS);
        assert.equal(
          grandchildDead,
          true,
          `grandchild ${pids.grandchildPid} must be cleaned when foreground execution settles`,
        );
      } finally {
        const cleaned = await tracker.cleanup();
        await closeAdapter(adapter, "foreground adapter close");
        t.diagnostic(
          `fixture cleanup: pids=${cleaned.join(",") || "none"} alive=${
            cleaned.filter(isPidAlive).join(",") || "none"
          }`,
        );
      }
    });
  },
);

test(
  "explicit background keeps the tree while root is alive and stop kills all",
  { skip: WINDOWS_ONLY, timeout: 35_000 },
  async (t) => {
    await withTempDir("zcode-derived-background-", async (dir) => {
      const token = randomUUID();
      const rootScript = await writeRootScript(dir);
      const pidFile = join(dir, "pids.json");
      const adapter = makeAdapter(dir);
      const tracker = createPidTracker();
      try {
        const task = await startExplicitBackground(
          adapter,
          rootScript,
          pidFile,
          token,
          "hold",
          "background",
        );
        tracker.remember(task.pid);
        const pids = await readFixturePids(pidFile, token, PID_WAIT_MS);
        tracker.remember(pids.rootPid);
        tracker.remember(pids.grandchildPid);

        await delay(300);
        assert.equal(isPidAlive(pids.rootPid), true, "background root must stay alive until stop");
        assert.equal(
          isPidAlive(pids.grandchildPid),
          true,
          "background grandchild must stay alive until stop",
        );

        await adapter.cancelBackgroundTask(task.taskId);
        await withTimeout(
          adapter.waitForBackgroundTask(task.taskId),
          10_000,
          "background task completion after stop",
        );
        const rootDead = await waitForPidDead(pids.rootPid, DEATH_WAIT_MS);
        const grandchildDead = await waitForPidDead(pids.grandchildPid, DEATH_WAIT_MS);
        assert.equal(rootDead, true, `background root ${pids.rootPid} must be stopped`);
        assert.equal(
          grandchildDead,
          true,
          `background grandchild ${pids.grandchildPid} must be stopped`,
        );
      } finally {
        const cleaned = await tracker.cleanup();
        await closeAdapter(adapter, "background adapter close");
        t.diagnostic(
          `fixture cleanup: pids=${cleaned.join(",") || "none"} alive=${
            cleaned.filter(isPidAlive).join(",") || "none"
          }`,
        );
      }
    });
  },
);

test(
  "background root exit and completion leave no descendant",
  { skip: WINDOWS_ONLY, timeout: 35_000 },
  async (t) => {
    await withTempDir("zcode-derived-background-exit-", async (dir) => {
      const token = randomUUID();
      const rootScript = await writeRootScript(dir);
      const pidFile = join(dir, "pids.json");
      const adapter = makeAdapter(dir);
      const tracker = createPidTracker();
      try {
        const task = await startExplicitBackground(
          adapter,
          rootScript,
          pidFile,
          token,
          "exit",
          "background-exit",
        );
        tracker.remember(task.pid);
        const pids = await readFixturePids(pidFile, token, PID_WAIT_MS);
        tracker.remember(pids.rootPid);
        tracker.remember(pids.grandchildPid);

        const completion = await withTimeout(
          adapter.waitForBackgroundTask(task.taskId),
          15_000,
          "background completion after root exit",
        );
        assert.equal(completion?.status, "completed");
        const rootDead = await waitForPidDead(pids.rootPid, DEATH_WAIT_MS);
        const grandchildDead = await waitForPidDead(pids.grandchildPid, DEATH_WAIT_MS);
        assert.equal(rootDead, true, `background root ${pids.rootPid} must have exited`);
        assert.equal(
          grandchildDead,
          true,
          `completed background task must not leave grandchild ${pids.grandchildPid}`,
        );
      } finally {
        const cleaned = await tracker.cleanup();
        await closeAdapter(adapter, "background-exit adapter close");
        t.diagnostic(
          `fixture cleanup: pids=${cleaned.join(",") || "none"} alive=${
            cleaned.filter(isPidAlive).join(",") || "none"
          }`,
        );
      }
    });
  },
);

test(
  "adapter.close stops a running background tree",
  { skip: WINDOWS_ONLY, timeout: 35_000 },
  async (t) => {
    await withTempDir("zcode-derived-close-", async (dir) => {
      const token = randomUUID();
      const rootScript = await writeRootScript(dir);
      const pidFile = join(dir, "pids.json");
      const adapter = makeAdapter(dir);
      const tracker = createPidTracker();
      try {
        const task = await startExplicitBackground(
          adapter,
          rootScript,
          pidFile,
          token,
          "hold",
          "close",
        );
        tracker.remember(task.pid);
        const pids = await readFixturePids(pidFile, token, PID_WAIT_MS);
        tracker.remember(pids.rootPid);
        tracker.remember(pids.grandchildPid);
        assert.equal(isPidAlive(pids.grandchildPid), true);

        await closeAdapter(adapter, "adapter.execute close");
        const rootDead = await waitForPidDead(pids.rootPid, DEATH_WAIT_MS);
        const grandchildDead = await waitForPidDead(pids.grandchildPid, DEATH_WAIT_MS);
        assert.equal(rootDead, true, `adapter.close must stop root ${pids.rootPid}`);
        assert.equal(
          grandchildDead,
          true,
          `adapter.close must stop grandchild ${pids.grandchildPid}`,
        );
      } finally {
        const cleaned = await tracker.cleanup();
        await closeAdapter(adapter, "close adapter cleanup");
        t.diagnostic(
          `fixture cleanup: pids=${cleaned.join(",") || "none"} alive=${
            cleaned.filter(isPidAlive).join(",") || "none"
          }`,
        );
      }
    });
  },
);

test(
  "owner crash closes the per-execution job and leaves no orphan",
  { skip: WINDOWS_ONLY, timeout: 45_000 },
  async (t) => {
    await withTempDir("zcode-derived-owner-", async (dir) => {
      const token = randomUUID();
      const rootScript = await writeRootScript(dir);
      const managerScript = await writeManagerScript(dir);
      const pidFile = join(dir, "pids.json");
      const readyFile = join(dir, "ready.json");
      const tracker = createPidTracker();
      let managerStderr = "";
      const manager = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          managerScript,
          rootScript,
          pidFile,
          readyFile,
          token,
          join(dir, "output"),
        ],
        {
          cwd: WORKSPACE_ROOT,
          env: { ...process.env, ADAPTER_MODULE_URL },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      tracker.remember(manager.pid);
      manager.stderr?.on("data", (chunk: Buffer | string) => {
        managerStderr += String(chunk);
      });

      try {
        await waitForFile(readyFile, PID_WAIT_MS, "owner manager ready file").catch((error) => {
          throw new Error(`${String(error)}\nowner manager stderr:\n${managerStderr}`);
        });
        const pids = await readFixturePids(pidFile, token, PID_WAIT_MS);
        tracker.remember(pids.rootPid);
        tracker.remember(pids.grandchildPid);
        assert.equal(isPidAlive(pids.rootPid), true, "owner fixture root must be alive");
        assert.equal(
          isPidAlive(pids.grandchildPid),
          true,
          "owner fixture grandchild must be alive",
        );
        assert.ok(manager.pid, "owner manager must expose its pid");

        // 只杀本测试 spawn 的 fixture manager，不碰任何现有 YCode 进程。
        killExactPid(manager.pid);
        await waitForChildExit(manager, 10_000);

        const rootDead = await waitForPidDead(pids.rootPid, DEATH_WAIT_MS);
        const grandchildDead = await waitForPidDead(pids.grandchildPid, DEATH_WAIT_MS);
        assert.equal(rootDead, true, `owner crash must stop root ${pids.rootPid}`);
        assert.equal(
          grandchildDead,
          true,
          `owner crash must stop grandchild ${pids.grandchildPid}`,
        );
      } finally {
        if (manager.pid !== undefined && isPidAlive(manager.pid)) killExactPid(manager.pid);
        await waitForChildExit(manager, 5_000).catch(() => undefined);
        const cleaned = await tracker.cleanup();
        t.diagnostic(
          `fixture cleanup: pids=${cleaned.join(",") || "none"} alive=${
            cleaned.filter(isPidAlive).join(",") || "none"
          } managerStderr=${managerStderr.trim() || "none"}`,
        );
      }
    });
  },
);

test(
  "fast root exit is covered by the production job readiness barrier",
  { skip: WINDOWS_ONLY, timeout: 35_000 },
  async (t) => {
    await withTempDir("zcode-derived-fast-exit-", async (dir) => {
      const token = randomUUID();
      const pidFile = join(dir, "pids.json");
      const adapter = makeAdapter(dir);
      const tracker = createPidTracker();
      let pids: FixturePids | undefined;
      try {
        // 不注入 factory，也不等待 Job ready：root 在同一事件循环内创建孙进程并退出。
        const result = await adapter.run({
          command: {
            mode: "argv",
            file: process.execPath,
            args: ["-e", FAST_EXIT_ROOT, pidFile, token],
          },
          timeoutMs: 20_000,
          trace: traceContext("fast-exit", token),
        });
        pids = await readFixturePids(pidFile, token, PID_WAIT_MS);
        tracker.remember(pids.rootPid);
        tracker.remember(pids.grandchildPid);
        assert.equal(result.status, "completed");

        const grandchildDead = await waitForPidDead(pids.grandchildPid, DEATH_WAIT_MS);
        assert.equal(
          grandchildDead,
          true,
          `fast-exit grandchild ${pids.grandchildPid} must be cleaned by the production barrier`,
        );
      } finally {
        const cleaned = await tracker.cleanup();
        await closeAdapter(adapter, "fast-exit adapter close");
        t.diagnostic(
          `fixture cleanup: pids=${cleaned.join(",") || "none"} alive=${
            cleaned.filter(isPidAlive).join(",") || "none"
          }`,
        );
      }
    });
  },
);
