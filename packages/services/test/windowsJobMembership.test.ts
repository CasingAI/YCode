import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { createWindowsJobMembership } from "../src/process/windowsJobMembership.js";

// 统计用 Job 的契约（docs/specs/resource-manager-process-sampling.md）：
// 它只提供存活成员 PID；原生能力不可用时必须静默回退，不能影响 Host 启动与既有归属。

const WIN32 = process.platform === "win32";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("非 Windows 平台不创建统计 Job", async () => {
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
  });

  assert.equal(membership, undefined);
  assert.equal(closed, 1);
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

test("真实 Job 能枚举到进程自身与后来创建的后代", { skip: !WIN32 }, async () => {
  const membership = await createWindowsJobMembership();
  assert.ok(membership, "Windows 上应能创建统计 Job");

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

    assert.ok(pids?.includes(process.pid), "统计 Job 必须包含 Host 自身");
    assert.ok(pids?.includes(childPid), "统计 Job 必须包含继承成员身份的后代");
  } finally {
    child?.kill();
    membership.close();
  }
});
