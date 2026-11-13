// 隔离的 Host 容器 fixture：只操作本进程自己派生、自己记录的 PID。
//
// 目的：验证 kill-on-close 的 Host 容器在 owner 进程退出（内核关闭句柄）后，
// 能终止仍存活的脱离父链孙进程。绝不把测试 runner 或任何既有进程放进该作业。
//
// 协议：
// - stdout 第一行输出 `pid=<grandchildPid>`。
// - 收到 stdin 的 `exit` 后以 process.exit(0) 退出，不主动 close 句柄，由 OS 关闭触发内核回收。
// - 环境变量 ZCODE_CONTAINMENT_KILL_ON_CLOSE=0 关闭容器的 kill-on-close（负向对照用）。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createWindowsJobMembership } from "../../src/process/windowsJobMembership.js";

const pidFile = join(tmpdir(), `zcode-containment-grandchild-${process.pid}.pid`);

// 负向对照：ZCODE_CONTAINMENT_KILL_ON_CLOSE=0 时用纯统计 Job，容器不负责回收，
// 用来证明 fixture 确实制造了脱离父链、能独立存活的孙进程（测试需自行按 PID 清理）。
const killOnJobClose = process.env.ZCODE_CONTAINMENT_KILL_ON_CLOSE !== "0";

const membership = await createWindowsJobMembership({ killOnJobClose });
if (!membership) {
  console.error("containment fixture failed to create host lifecycle job");
  process.exit(2);
}

// 中间进程继承容器成员身份，派生出脱离父链的孙进程后立即退出。
const intermediate = spawn(
  process.execPath,
  [
    "-e",
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const pidFile = ${JSON.stringify(pidFile)};`,
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'],",
      "  { stdio: 'ignore', windowsHide: true, detached: true });",
      "grandchild.unref();",
      "fs.writeFileSync(pidFile, String(grandchild.pid));",
    ].join("\n"),
  ],
  { stdio: "ignore", windowsHide: true },
);

await new Promise<void>((resolve, reject) => {
  intermediate.once("error", reject);
  intermediate.once("exit", () => resolve());
});

let grandchildPid: number | undefined;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const parsed = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      grandchildPid = parsed;
      break;
    }
  } catch {
    // 文件尚未写入。
  }
  await delay(50);
}

if (!grandchildPid) {
  console.error("containment fixture did not observe grandchild pid");
  process.exit(3);
}

process.stdout.write(`pid=${grandchildPid}\n`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "exit") break;
}
// 不调用 membership.close()：交给进程退出时操作系统关闭句柄。
process.exit(0);
