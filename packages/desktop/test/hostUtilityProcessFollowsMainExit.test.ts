import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// 实证：Electron Main 被强制终止时，它 fork 的 UtilityProcess 是否跟随退出。
// Host 以 UtilityProcess 运行；只有 Utility 跟随 Main 退出，Host 的 kill-on-close 句柄
// 才会在 Main 崩溃/被强杀时由内核关闭并回收派生树。此前“process.disconnect 必然触发”的
// 说法没有依据：utility 的 process.parentPort 不是 Node IPC，不能据此推断。
// 该 fixture 完全独立：新 spawn Electron、无窗口、隔离 userData，只 kill 自己记录的 PID。
const WIN32 = process.platform === "win32";
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonWhenReady<T>(path: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw new Error(`fixture 未在限定时间内写出结果: ${String(lastError)}`);
}

async function readPidWhenReady(path: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    } catch {
      // 等待 fixture 写出。
    }
    await wait(100);
  }
  throw new Error("fixture 未在限定时间内报告 utility child PID");
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error("fixture Main 未在限定时间内退出")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

test(
  "Main 被强制终止后 Electron UtilityProcess 跟随退出",
  { skip: !WIN32, timeout: 60_000 },
  async () => {
    assert.ok(existsSync(electronPath), "需要本地 Electron 可执行文件");

    const workDir = mkdtempSync(join(tmpdir(), "zcode-utility-follow-exit-"));
    const reportPath = join(workDir, "report.json");
    const childPidPath = join(workDir, "child.pid");
    const userDataDir = join(workDir, "userData");
    const env = { ...process.env };
    // 避免 Electron 被当作纯 Node 运行；fixture 与宿主进程完全隔离。
    delete env.ELECTRON_RUN_AS_NODE;
    env.ZCODE_UTILITY_FOLLOW_EXIT_REPORT = reportPath;
    env.ZCODE_UTILITY_CHILD_PID_FILE = childPidPath;
    env.ZCODE_UTILITY_FOLLOW_EXIT_USER_DATA = userDataDir;

    let mainProcess: ChildProcess | undefined;
    let mainPid: number | undefined;
    let childPid: number | undefined;
    try {
      const spawned = spawn(
        electronPath,
        [resolve(import.meta.dirname, "fixtures", "utilityProcessFollowExitMain.cjs")],
        {
          stdio: "ignore",
          windowsHide: true,
          env,
        },
      );
      mainProcess = spawned;

      const report = await readJsonWhenReady<{ mainPid: number }>(reportPath, 30_000);
      mainPid = report.mainPid;
      // UtilityProcess.pid 在 fork 返回时尚未就绪；以 child 自报的 pid 为准。
      childPid = await readPidWhenReady(childPidPath, 30_000);
      assert.equal(mainPid, spawned.pid, "fixture Main 必须就是新 spawn 的进程");
      assert.ok(isProcessAlive(mainPid), "fixture Main 应在运行");
      assert.ok(isProcessAlive(childPid), "utility child 应在运行");

      // 只终止本测试新建的 fixture Main，模拟强制关闭/崩溃。
      process.kill(mainPid);
      await waitForExit(spawned, 15_000);
      assert.equal(isProcessAlive(mainPid), false, "fixture Main 应已退出");

      let followed = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!isProcessAlive(childPid)) {
          followed = true;
          break;
        }
        await wait(100);
      }
      assert.equal(
        followed,
        true,
        "Main 退出后 utility child 应跟随退出，Host 容器句柄才会被内核关闭",
      );
    } finally {
      // 兜底：只按本测试记录的精确 PID 清理自建 fixture。
      if (mainPid !== undefined && isProcessAlive(mainPid)) {
        try {
          process.kill(mainPid);
        } catch {
          // 已退出时忽略。
        }
      }
      if (mainProcess && mainProcess.exitCode === null && !mainProcess.killed) {
        mainProcess.kill();
        await wait(500);
      }
      if (childPid !== undefined && isProcessAlive(childPid)) {
        try {
          process.kill(childPid);
          await wait(300);
        } catch {
          // 已退出时忽略。
        }
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
