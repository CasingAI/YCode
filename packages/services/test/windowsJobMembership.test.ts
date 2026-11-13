import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  createWindowsJobMembership,
  type WindowsJobMembershipDiagnostic,
} from "../src/process/windowsJobMembership.js";

// Host 生命周期 Job 的契约：
// - 默认只承担统计（不设置 KILL_ON_JOB_CLOSE），其他 caller 的语义与清理行为不变；
// - Host 显式开启 kill-on-close，句柄随 Host 进程退出由内核关闭并回收残留派生树；
// - 原生能力不可用时返回 undefined 并给出一次诊断，不静默掩盖清理保证降级。
// 参见 docs/specs/host-process-containment-cleanup.md 与 resource-manager-process-sampling.md。
const WIN32 = process.platform === "win32";
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

test("非 Windows 平台不创建 Host 生命周期 Job", async () => {
  const membership = await createWindowsJobMembership({ platform: "linux" });
  assert.equal(membership, undefined);
});

test("成员查询失败时返回 undefined，不抛错", async () => {
  let closed = 0;
  const membership = await createWindowsJobMembership({
    platform: "win32",
    api: {
      createJob: () => ({}),
      assignSelf: () => true,
      queryPids: () => {
        throw new Error("query failed");
      },
      close: () => {
        closed += 1;
      },
    },
  });

  assert.ok(membership);
  assert.equal(membership.listPids(), undefined);
  membership.close();
  membership.close();
  assert.equal(closed, 1);
});

test("加入作业失败时关闭句柄并回退", async () => {
  let closed = 0;
  const diagnostics: WindowsJobMembershipDiagnostic[] = [];
  const membership = await createWindowsJobMembership({
    platform: "win32",
    api: {
      createJob: () => ({}),
      assignSelf: () => false,
      queryPids: () => [],
      close: () => {
        closed += 1;
      },
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal(membership, undefined);
  assert.equal(closed, 1);
  assert.deepEqual(diagnostics, [{ stage: "assign", reason: "assign-self-failed" }]);
});

test("kill-on-close 加入阶段抛错时不关闭可能已包含自身的句柄", async () => {
  // 内核可能已成功把 Host 加入作业，原生桥接随后才抛错；此时 close 会误杀 Host 自身。
  let closed = 0;
  const diagnostics: WindowsJobMembershipDiagnostic[] = [];
  const membership = await createWindowsJobMembership({
    platform: "win32",
    killOnJobClose: true,
    api: {
      createJob: () => ({}),
      assignSelf: () => {
        throw new Error("native bridge failed after assign");
      },
      queryPids: () => [],
      close: () => {
        closed += 1;
      },
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal(membership, undefined);
  assert.equal(closed, 0, "不确定是否已包含 Host 自身时绝不能 close kill-on-close 句柄");
  assert.deepEqual(diagnostics, [{ stage: "assign", reason: "Error" }]);
});

test("纯统计 Job 加入阶段抛错时仍关闭句柄", async () => {
  let closed = 0;
  const membership = await createWindowsJobMembership({
    platform: "win32",
    api: {
      createJob: () => ({}),
      assignSelf: () => {
        throw new Error("assign failed");
      },
      queryPids: () => [],
      close: () => {
        closed += 1;
      },
    },
  });

  assert.equal(membership, undefined);
  assert.equal(closed, 1, "纯统计 Job 不包含 Host 自身，按原语义关闭避免泄漏");
});

test("创建阶段抛错时没有句柄可关，不误关任何对象", async () => {
  let closed = 0;
  const diagnostics: WindowsJobMembershipDiagnostic[] = [];
  const membership = await createWindowsJobMembership({
    platform: "win32",
    killOnJobClose: true,
    api: {
      createJob: () => {
        throw new Error("create failed");
      },
      assignSelf: () => true,
      queryPids: () => [],
      close: () => {
        closed += 1;
      },
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal(membership, undefined);
  assert.equal(closed, 0);
  assert.deepEqual(diagnostics, [{ stage: "create", reason: "Error" }]);
});

test("查询返回存活成员列表", async () => {
  const membership = await createWindowsJobMembership({
    platform: "win32",
    api: {
      createJob: () => ({}),
      assignSelf: () => true,
      queryPids: () => [200, 401, 402],
      close: () => undefined,
    },
  });

  assert.deepEqual(membership?.listPids(), [200, 401, 402]);
});

test("首次成员枚举失败只告警一次，后续 tick 不重复输出", async () => {
  const diagnostics: WindowsJobMembershipDiagnostic[] = [];
  let queries = 0;
  const membership = await createWindowsJobMembership({
    platform: "win32",
    killOnJobClose: true,
    api: {
      createJob: () => ({}),
      assignSelf: () => true,
      queryPids: () => {
        queries += 1;
        throw new Error("query failed");
      },
      close: () => undefined,
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.ok(membership);
  // 多次采样 tick 都失败，但诊断只在第一次产生。
  assert.equal(membership.listPids(), undefined);
  assert.equal(membership.listPids(), undefined);
  assert.equal(membership.listPids(), undefined);
  assert.equal(queries, 3);
  assert.deepEqual(diagnostics, [{ stage: "query", reason: "Error" }]);
});

test("默认创建统计 Job：limit flags 只含 BREAKAWAY_OK", async () => {
  const flags: number[] = [];
  const membership = await createWindowsJobMembership({
    platform: "win32",
    api: {
      createJob: (options) => {
        // 注入 api 只记录调用方的选项，验证默认不开启 kill-on-close。
        flags.push(options.killOnJobClose ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0);
        return {};
      },
      assignSelf: () => true,
      queryPids: () => [],
      close: () => undefined,
    },
  });

  assert.ok(membership);
  assert.deepEqual(flags, [0], "默认统计 Job 不得开启 kill-on-close");

  // 对照：显式开启时才请求 kill-on-close。
  const enabled: boolean[] = [];
  const contained = await createWindowsJobMembership({
    platform: "win32",
    killOnJobClose: true,
    api: {
      createJob: (options) => {
        enabled.push(options.killOnJobClose);
        return {};
      },
      assignSelf: () => true,
      queryPids: () => [],
      close: () => undefined,
    },
  });
  assert.ok(contained);
  assert.deepEqual(enabled, [true]);
});

test(
  "真实 kill-on-close 容器在 owner 退出后回收脱离父链的孙进程",
  { skip: !WIN32, timeout: 30_000 },
  async () => {
    // fixture 是测试自建的隔离 owner：它创建自己的 kill-on-close 容器、加入自身、
    // 派生中间进程与脱离父链的孙进程，然后只输出孙进程精确 PID。测试 runner 不进入该作业，
    // 清理阶段也只按记录的 PID 操作自建 fixture，绝不触碰任何既有进程。
    const fixturePath = resolve(import.meta.dirname, "fixtures", "windowsJobContainmentOwner.ts");
    const owner: ChildProcess = spawn(process.execPath, ["--import", "tsx", fixturePath], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    const ownerExit = new Promise<number | null>((resolveExit) => {
      owner.once("exit", (code) => resolveExit(code));
    });

    let grandchildPid: number | undefined;
    try {
      if (!owner.stdout) throw new Error("containment fixture stdout unavailable");
      const reader = createInterface({ input: owner.stdout });
      for await (const line of reader) {
        const match = /^pid=(\d+)$/.exec(line.trim());
        if (match) {
          grandchildPid = Number.parseInt(match[1] ?? "", 10);
          break;
        }
      }
      assert.ok(grandchildPid, "fixture 必须报告其孙进程 PID");
      assert.ok(isProcessAlive(grandchildPid), "孙进程在 owner 存活时应在运行");

      // owner 不 close 句柄直接退出，模拟 Host 进程结束；内核关闭最后一个句柄后应回收成员。
      owner.stdin?.write("exit\n");
      const code = await ownerExit;
      assert.equal(code, 0);

      let terminated = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!isProcessAlive(grandchildPid)) {
          terminated = true;
          break;
        }
        await wait(100);
      }
      assert.equal(terminated, true, "kill-on-close 容器必须在 owner 退出后终止残留孙进程");
    } finally {
      // 兜底清理：只按本测试记录的精确 PID 处理自建 fixture。
      if (!owner.killed && owner.exitCode === null) {
        owner.kill();
        await wait(500);
      }
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid);
        } catch {
          // 已退出或没有权限时忽略，绝不能扩散到其他 PID。
        }
      }
    }
  },
);

test("负向对照：纯统计 Job 不回收脱离父链的孙进程", { skip: !WIN32, timeout: 30_000 }, async () => {
  // 证明上一测试的回收确实来自 kill-on-close 容器，而不是 fixture 本身偶然退出。
  // 仍然只按记录的精确 PID 清理自建 fixture。
  const fixturePath = resolve(import.meta.dirname, "fixtures", "windowsJobContainmentOwner.ts");
  const owner: ChildProcess = spawn(process.execPath, ["--import", "tsx", fixturePath], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    env: { ...process.env, ZCODE_CONTAINMENT_KILL_ON_CLOSE: "0" },
  });
  const ownerExit = new Promise<number | null>((resolveExit) => {
    owner.once("exit", (code) => resolveExit(code));
  });

  let grandchildPid: number | undefined;
  try {
    if (!owner.stdout) throw new Error("containment fixture stdout unavailable");
    const reader = createInterface({ input: owner.stdout });
    for await (const line of reader) {
      const match = /^pid=(\d+)$/.exec(line.trim());
      if (match) {
        grandchildPid = Number.parseInt(match[1] ?? "", 10);
        break;
      }
    }
    assert.ok(grandchildPid);
    owner.stdin?.write("exit\n");
    assert.equal(await ownerExit, 0);
    await wait(1_000);
    assert.equal(isProcessAlive(grandchildPid), true, "纯统计 Job 不应在 owner 退出后终止孙进程");
  } finally {
    if (!owner.killed && owner.exitCode === null) {
      owner.kill();
      await wait(500);
    }
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid);
        await wait(300);
      } catch {
        // 已退出或没有权限时忽略，绝不能扩散到其他 PID。
      }
    }
  }
});

test("真实 Job 能枚举到进程自身与后来创建的后代", { skip: !WIN32 }, async () => {
  const membership = await createWindowsJobMembership();
  assert.ok(membership, "Windows 上应能创建 Host 生命周期 Job");

  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const childPid = child.pid;
    assert.ok(childPid);

    let pids: number[] | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      pids = membership.listPids();
      if (pids?.includes(process.pid) && pids.includes(childPid)) break;
      await wait(100);
    }

    assert.ok(pids?.includes(process.pid), "Job 必须包含 Host 自身");
    assert.ok(pids?.includes(childPid), "Job 必须包含继承成员身份的后代");
  } finally {
    child?.kill();
    membership.close();
  }
});
