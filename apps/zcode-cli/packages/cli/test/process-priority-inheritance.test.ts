// Linux 浏览器宿主的继承前提（docs/specs/process-priority.md）。
//
// 用例只创建和回收测试自己的短命 Node 进程：测试进程只把自己降为 idle，不调用任何
// 提升优先级的 API；随后 spawn 子进程读回优先级，验证子进程继承父进程当前值。已有
// 更低优先级时共享 helper 返回 unchanged。它不启动 Chromium，也不操作正在运行的 YCode。
// Linux 实机上的 Chromium zygote/launcher 继承仍需在 Linux 环境单独验证。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants as osConstants, getPriority } from "node:os";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { lowerProcessPriority } from "@zcode/shared/process-priority";

const execFileAsync = promisify(execFile);
const SUPPORTED =
  process.platform === "win32" || process.platform === "darwin" || process.platform === "linux";
const IDLE = osConstants.priority.PRIORITY_LOW;

test(
  "a self-lowered idle parent spawns a child that inherits the same priority",
  { skip: !SUPPORTED },
  async () => {
    // 只降不升：不先设置 Normal，也不在测试结束时恢复；已有更低值保持 unchanged。
    const first = lowerProcessPriority(process.pid, "idle");
    const second = lowerProcessPriority(process.pid, "idle");
    assert.ok(first === "applied" || first === "unchanged", `unexpected priority result ${first}`);
    assert.equal(second, "unchanged", "reapplying idle must not raise an existing value");

    const own = getPriority(process.pid);
    assert.ok(own >= IDLE, `unexpected parent priority ${own}`);

    const { stdout } = await execFileAsync(
      process.execPath,
      ["-e", "process.stdout.write(String(require('node:os').getPriority(process.pid)))"],
      { timeout: 15_000 },
    );

    assert.equal(
      Number(stdout),
      own,
      "the spawned child must inherit the self-lowered parent priority",
    );
  },
);
