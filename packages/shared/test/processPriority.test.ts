import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, getPriority } from "node:os";
import test from "node:test";
import {
  lowerProcessPriority,
  type LowerProcessPriorityOptions,
  type ProcessPriority,
} from "../src/node/processPriority.js";

const PRIORITY_BELOW_NORMAL = constants.priority.PRIORITY_BELOW_NORMAL;
const PRIORITY_LOW = constants.priority.PRIORITY_LOW;
const IS_WINDOWS = process.platform === "win32";

// 子进程先等待，让父进程有机会在本进程 spawn 后代之前完成 Idle 设置。
const DESCENDANT_SPAWN_SCRIPT = `
const { spawn } = require("node:child_process");
setTimeout(() => {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  grandchild.on("spawn", () => process.stdout.write(String(grandchild.pid) + "\\n"));
}, 300);
setTimeout(() => {}, 15000);
`;

function fakeOptions(
  current: number | (() => number),
  calls: Array<{ pid: number; priority: number }>,
): LowerProcessPriorityOptions {
  return {
    platform: "win32",
    getPriority: typeof current === "function" ? current : () => current,
    setPriority: (pid, priority) => {
      calls.push({ pid, priority });
    },
  };
}

test("非 Windows 跳过且不访问 OS", () => {
  let touched = false;
  const result = lowerProcessPriority(1234, "idle", {
    platform: "linux",
    getPriority: () => {
      touched = true;
      return 0;
    },
    setPriority: () => {
      touched = true;
    },
  });

  assert.equal(result, "skipped");
  assert.equal(touched, false);
});

test("非法 PID 不访问 OS", () => {
  for (const pid of [null, undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    let touched = false;
    const result = lowerProcessPriority(pid, "idle", {
      platform: "win32",
      getPriority: () => {
        touched = true;
        return 0;
      },
      setPriority: () => {
        touched = true;
      },
    });

    assert.equal(result, "skipped", `pid=${String(pid)}`);
    assert.equal(touched, false, `pid=${String(pid)}`);
  }
});

test("读取失败直接 failed 且不设置", () => {
  const calls: Array<{ pid: number; priority: number }> = [];
  const result = lowerProcessPriority(1234, "below-normal", {
    platform: "win32",
    getPriority: () => {
      throw new Error("EPERM");
    },
    setPriority: (pid, priority) => {
      calls.push({ pid, priority });
    },
  });

  assert.equal(result, "failed");
  assert.deepEqual(calls, []);
});

test("读取到非有限值按失败处理，不设置", () => {
  const calls: Array<{ pid: number; priority: number }> = [];
  const result = lowerProcessPriority(1234, "idle", fakeOptions(Number.NaN, calls));

  assert.equal(result, "failed");
  assert.deepEqual(calls, []);
});

test("已经不低于目标优先级时保持不变", () => {
  const cases: Array<{ current: number; priority: ProcessPriority }> = [
    { current: PRIORITY_BELOW_NORMAL, priority: "below-normal" },
    { current: PRIORITY_LOW, priority: "below-normal" },
    { current: PRIORITY_LOW, priority: "idle" },
  ];

  for (const { current, priority } of cases) {
    const calls: Array<{ pid: number; priority: number }> = [];
    const result = lowerProcessPriority(1234, priority, fakeOptions(current, calls));

    assert.equal(result, "unchanged", `${priority} current=${current}`);
    assert.deepEqual(calls, [], `${priority} current=${current}`);
  }
});

test("正常优先级降为目标值，且只同步写入一次", () => {
  const belowCalls: Array<{ pid: number; priority: number }> = [];
  assert.equal(
    lowerProcessPriority(1234, "below-normal", fakeOptions(0, belowCalls)),
    "applied",
  );
  assert.deepEqual(belowCalls, [{ pid: 1234, priority: PRIORITY_BELOW_NORMAL }]);

  const idleCalls: Array<{ pid: number; priority: number }> = [];
  assert.equal(lowerProcessPriority(1234, "idle", fakeOptions(0, idleCalls)), "applied");
  assert.deepEqual(idleCalls, [{ pid: 1234, priority: PRIORITY_LOW }]);
});

test("设置失败返回 failed 且不抛出", () => {
  const result = lowerProcessPriority(1234, "idle", {
    platform: "win32",
    getPriority: () => 0,
    setPriority: () => {
      throw new Error("EPERM");
    },
  });

  assert.equal(result, "failed");
});

test(
  "Windows：真实短命子进程读回 Below Normal / Idle",
  { skip: !IS_WINDOWS, timeout: 15_000 },
  (t) => {
    const parentBefore = getPriority(process.pid);
    if (parentBefore >= PRIORITY_BELOW_NORMAL) {
      // 当前测试进程已被外部降级时无法验证降级，但也绝不能为了提高优先级而修改父进程。
      t.skip("test process is already below normal or lower");
      return;
    }

    const belowNormal = spawnShortLivedNode();
    const idle = spawnShortLivedNode();
    try {
      assert.ok(belowNormal.pid);
      assert.ok(idle.pid);

      assert.equal(lowerProcessPriority(belowNormal.pid, "below-normal"), "applied");
      assert.equal(getPriority(belowNormal.pid), PRIORITY_BELOW_NORMAL);

      assert.equal(lowerProcessPriority(idle.pid, "idle"), "applied");
      assert.equal(getPriority(idle.pid), PRIORITY_LOW);

      assert.equal(getPriority(process.pid), parentBefore);
    } finally {
      killQuietly(belowNormal);
      killQuietly(idle);
    }
  },
);

test(
  "Windows：已降级子进程的后代继承 Idle",
  { skip: !IS_WINDOWS, timeout: 15_000 },
  async () => {
    const parentBefore = getPriority(process.pid);
    const child = spawn(process.execPath, ["-e", DESCENDANT_SPAWN_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let grandchildPid: number | undefined;
    try {
      assert.ok(child.pid);
      assert.ok(child.stdout);

      lowerProcessPriority(child.pid, "idle");
      assert.equal(getPriority(child.pid), PRIORITY_LOW);

      grandchildPid = Number(
        await readFirstLine(child.stdout, 8_000).catch((error: unknown) => {
          throw new Error(`grandchild pid was not reported: ${String(error)}`);
        }),
      );
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      assert.equal(getPriority(grandchildPid), PRIORITY_LOW);

      assert.equal(getPriority(process.pid), parentBefore);
    } finally {
      if (grandchildPid !== undefined) killPidQuietly(grandchildPid);
      killQuietly(child);
    }
  },
);

function spawnShortLivedNode(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    const onData = (chunk: string | Buffer) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline).trim());
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
    };
    stream.on("data", onData);
  });
}

function killQuietly(child: ChildProcess): void {
  if (child.pid !== undefined) killPidQuietly(child.pid);
}

function killPidQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 子进程可能已自行退出；测试清理要求幂等。
  }
}
