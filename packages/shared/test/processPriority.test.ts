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
const SUPPORTED_PLATFORMS: NodeJS.Platform[] = ["win32", "darwin", "linux"];
const IS_SUPPORTED_PLATFORM = SUPPORTED_PLATFORMS.includes(process.platform);

// 子进程收到父进程通过 stdin 发出的通知后才创建孙进程，保证父进程已完成降级。
const DESCENDANT_SPAWN_SCRIPT = `
const { spawn } = require("node:child_process");
process.stdin.once("data", () => {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  grandchild.on("spawn", () => process.stdout.write(String(grandchild.pid) + "\\n"));
});
setTimeout(() => {}, 15000);
`;

interface FakePriorityOs {
  readonly options: LowerProcessPriorityOptions;
  readonly calls: Array<{ pid: number; priority: number }>;
  priority(): number;
}

function createFakeOs(
  platform: NodeJS.Platform,
  initial: number,
  failures: { get?: boolean; set?: boolean } = {},
): FakePriorityOs {
  let current = initial;
  const calls: Array<{ pid: number; priority: number }> = [];
  return {
    options: {
      platform,
      getPriority: () => {
        if (failures.get) throw new Error("EPERM");
        return current;
      },
      setPriority: (pid, priority) => {
        if (failures.set) throw new Error("EPERM");
        calls.push({ pid, priority });
        current = priority;
      },
    },
    calls,
    priority: () => current,
  };
}

function targetOf(priority: ProcessPriority): number {
  return priority === "below-normal" ? PRIORITY_BELOW_NORMAL : PRIORITY_LOW;
}

test("三个支持平台：正常优先级降到目标值且只写入一次", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    const belowNormal = createFakeOs(platform, 0);
    assert.equal(
      lowerProcessPriority(1234, "below-normal", belowNormal.options),
      "applied",
      platform,
    );
    assert.deepEqual(belowNormal.calls, [{ pid: 1234, priority: PRIORITY_BELOW_NORMAL }], platform);
    assert.equal(belowNormal.priority(), PRIORITY_BELOW_NORMAL, platform);

    const idle = createFakeOs(platform, 0);
    assert.equal(lowerProcessPriority(1234, "idle", idle.options), "applied", platform);
    assert.deepEqual(idle.calls, [{ pid: 1234, priority: PRIORITY_LOW }], platform);
    assert.equal(idle.priority(), PRIORITY_LOW, platform);
  }
});

test("三个支持平台：当前 15 不提高到 10，可继续降到 19", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    const unchanged = createFakeOs(platform, 15);
    assert.equal(
      lowerProcessPriority(1234, "below-normal", unchanged.options),
      "unchanged",
      platform,
    );
    assert.deepEqual(unchanged.calls, [], platform);
    assert.equal(unchanged.priority(), 15, platform);

    const lowered = createFakeOs(platform, 15);
    assert.equal(lowerProcessPriority(1234, "idle", lowered.options), "applied", platform);
    assert.deepEqual(lowered.calls, [{ pid: 1234, priority: PRIORITY_LOW }], platform);
    assert.equal(lowered.priority(), PRIORITY_LOW, platform);
  }
});

test("三个支持平台：目标值或更低优先级保持不变", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    for (const { current, priority } of [
      { current: PRIORITY_BELOW_NORMAL, priority: "below-normal" },
      { current: PRIORITY_LOW, priority: "below-normal" },
      { current: PRIORITY_LOW, priority: "idle" },
    ] as Array<{ current: number; priority: ProcessPriority }>) {
      const fake = createFakeOs(platform, current);
      assert.equal(
        lowerProcessPriority(1234, priority, fake.options),
        "unchanged",
        `${platform} ${priority} current=${current}`,
      );
      assert.deepEqual(fake.calls, [], `${platform} ${priority} current=${current}`);
      assert.equal(fake.priority(), current, `${platform} ${priority} current=${current}`);
    }
  }
});

test("macOS：已继承 nice 20 时不提高到 Node 可设置的目标值", () => {
  for (const priority of ["below-normal", "idle"] as const) {
    const fake = createFakeOs("darwin", 20);
    assert.equal(lowerProcessPriority(1234, priority, fake.options), "unchanged", priority);
    assert.deepEqual(fake.calls, [], priority);
    assert.equal(fake.priority(), 20, priority);
  }
});

test("三个支持平台：重复应用同一目标不重复设置", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    const fake = createFakeOs(platform, 0);
    assert.equal(lowerProcessPriority(1234, "idle", fake.options), "applied", platform);
    assert.equal(lowerProcessPriority(1234, "idle", fake.options), "unchanged", platform);
    assert.deepEqual(fake.calls, [{ pid: 1234, priority: PRIORITY_LOW }], platform);
  }
});

test("三个支持平台：非法 PID 跳过且不访问 OS", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    for (const pid of [null, undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let touched = false;
      const result = lowerProcessPriority(pid, "idle", {
        platform,
        getPriority: () => {
          touched = true;
          return 0;
        },
        setPriority: () => {
          touched = true;
        },
      });

      assert.equal(result, "skipped", `${platform} pid=${String(pid)}`);
      assert.equal(touched, false, `${platform} pid=${String(pid)}`);
    }
  }
});

test("三个支持平台：读取失败直接 failed 且不设置", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    const fake = createFakeOs(platform, 0, { get: true });
    assert.equal(lowerProcessPriority(1234, "below-normal", fake.options), "failed", platform);
    assert.deepEqual(fake.calls, [], platform);
  }
});

test("三个支持平台：读取到非有限值按失败处理且不设置", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    const calls: Array<{ pid: number; priority: number }> = [];
    const result = lowerProcessPriority(1234, "idle", {
      platform,
      getPriority: () => Number.NaN,
      setPriority: (pid, priority) => {
        calls.push({ pid, priority });
      },
    });

    assert.equal(result, "failed", platform);
    assert.deepEqual(calls, [], platform);
  }
});

test("三个支持平台：设置失败返回 failed 且不抛出", () => {
  for (const platform of SUPPORTED_PLATFORMS) {
    const fake = createFakeOs(platform, 0, { set: true });
    assert.equal(lowerProcessPriority(1234, "idle", fake.options), "failed", platform);
  }
});

test("不支持平台跳过且不访问 OS", () => {
  for (const platform of ["freebsd", "aix", "openbsd", "sunos"] as NodeJS.Platform[]) {
    let touched = false;
    const result = lowerProcessPriority(1234, "idle", {
      platform,
      getPriority: () => {
        touched = true;
        return 0;
      },
      setPriority: () => {
        touched = true;
      },
    });

    assert.equal(result, "skipped", platform);
    assert.equal(touched, false, platform);
  }
});

test(
  "真实子进程：支持平台读回目标优先级或保留更低值，且不改变父进程",
  { skip: !IS_SUPPORTED_PLATFORM, timeout: 15_000 },
  () => {
    const parentBefore = getPriority(process.pid);
    const belowNormal = spawnShortLivedNode();
    const idle = spawnShortLivedNode();
    try {
      assert.ok(belowNormal.pid);
      assert.ok(idle.pid);

      assertLoweredTo(belowNormal.pid, "below-normal");
      assertLoweredTo(idle.pid, "idle");

      assert.equal(getPriority(process.pid), parentBefore);
    } finally {
      killQuietly(belowNormal);
      killQuietly(idle);
    }
  },
);

test(
  "真实子进程：父级降级后创建的后代继承目标优先级",
  { skip: !IS_SUPPORTED_PLATFORM, timeout: 15_000 },
  async () => {
    const parentBefore = getPriority(process.pid);
    const child = spawn(process.execPath, ["-e", DESCENDANT_SPAWN_SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let grandchildPid: number | undefined;
    try {
      assert.ok(child.pid);
      assert.ok(child.stdin);
      assert.ok(child.stdout);

      const { after } = assertLoweredTo(child.pid, "idle");

      // 降级完成后再通知子进程创建孙进程，避免依赖固定延迟同步。
      child.stdin.end("\n");
      grandchildPid = Number(
        await readFirstLine(child.stdout, 8_000).catch((error: unknown) => {
          throw new Error(`grandchild pid was not reported: ${String(error)}`);
        }),
      );
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
      assert.equal(getPriority(grandchildPid), after);

      assert.equal(getPriority(process.pid), parentBefore);
    } finally {
      if (grandchildPid !== undefined) killPidQuietly(grandchildPid);
      killQuietly(child);
    }
  },
);

/** 真实进程已继承更低优先级时保持原值，绝不为了测试把它提高。 */
function assertLoweredTo(
  pid: number,
  priority: ProcessPriority,
): { before: number; after: number } {
  const target = targetOf(priority);
  const before = getPriority(pid);
  const result = lowerProcessPriority(pid, priority);
  const after = getPriority(pid);

  assert.equal(result, before >= target ? "unchanged" : "applied", `pid=${pid} before=${before}`);
  assert.equal(after, before >= target ? before : target, `pid=${pid} before=${before}`);
  assert.ok(after >= target, `pid=${pid} after=${after} target=${target}`);
  return { before, after };
}

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
