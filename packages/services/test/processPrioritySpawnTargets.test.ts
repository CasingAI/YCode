import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getPriority, constants as osConstants } from "node:os";
import test from "node:test";
import type { IPty } from "node-pty";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";
import type { GitEnvironmentProvider } from "../src/git/providers/gitEnvironmentProvider.js";
import type { ISettingService } from "../src/setting/setting.js";
import { createTerminalService } from "../src/terminal/terminalService.js";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";

/**
 * 三平台进程优先级集成测试（docs/specs/process-priority.md）。
 *
 * 只观察测试自身创建的子进程，不查询、调整或结束任何既有 YCode / 系统进程。
 * Node 目标值为 Agent 10、工具 19。只降不升：子进程可能继承更低的优先级
 * （macOS nice 20），此时保留继承值，预期为 max(父进程值, 目标值)。
 */

const SUPPORTED =
  process.platform === "win32" || process.platform === "darwin" || process.platform === "linux";
const BELOW_NORMAL = osConstants.priority.PRIORITY_BELOW_NORMAL;
const LOW = osConstants.priority.PRIORITY_LOW;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

test("agent process is lowered to below normal after spawn", { skip: !SUPPORTED }, async () => {
  const parentPriorityBefore = getPriority();
  const manager = new ZCodeAgentProcessManager({
    commandResolver: () => ({
      command: process.execPath,
      // 子进程自行退出，测试只观察 spawn 返回后的同步降级；
      // 这样回收路径不必再向仍存活的测试子进程发送 taskkill。
      args: ["-e", "setTimeout(() => {}, 1500)"],
    }),
  });

  try {
    await manager.getClient({ workspacePath: process.cwd() });
    const [managed] = manager.listManagedProcesses();
    assert.ok(managed, "expected a managed agent process after getClient");
    // 子进程继承父进程已有优先级；只降不升，已更低时保持继承值。
    assert.equal(
      getPriority(managed.pid),
      Math.max(parentPriorityBefore, BELOW_NORMAL),
      "agent child must not be raised above below-normal (10)",
    );
    // 只降低子进程，不能连带改变创建方（Host/测试进程）的优先级。
    assert.equal(getPriority(), parentPriorityBefore);
    await waitFor(() => manager.listManagedProcesses().length === 0, 15_000);
  } finally {
    await manager.disposeAllAndWait();
  }
});

test("git command root is lowered to idle after spawn", { skip: !SUPPORTED }, async () => {
  const parentPriorityBefore = getPriority();
  // 子进程继承父进程已有优先级；只降不升，macOS 继承 nice 20 时保留 20。
  const expected = Math.max(parentPriorityBefore, LOW);
  const provider = createGitCommandProvider({
    platform: process.platform,
    environmentProvider: {
      resolveGitBinary: async () => process.execPath,
      createCommandEnv: () => ({ ...process.env }),
    } as GitEnvironmentProvider,
  });

  const result = await provider.run({
    cwd: process.cwd(),
    // 子进程等 250ms 再读，确保父进程在 spawn 返回后同步完成的降级已经生效。
    args: [
      "-e",
      "setTimeout(() => { process.stdout.write(String(require('node:os').getPriority())); }, 250)",
    ],
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), String(expected));
});

test("terminal shell is lowered to idle after pty spawn", { skip: !SUPPORTED }, async () => {
  const parentPriorityBefore = getPriority();
  // 注入真实子进程代表 pty shell PID：既验证调用点使用了 spawn 返回的 pid，
  // 又不在 Windows 持有 ConPTY、在 Unix 创建真实 pty。
  const shellChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    stdio: "ignore",
  });
  assert.ok(typeof shellChild.pid === "number");
  const shellExited = new Promise<void>((resolve) => shellChild.once("exit", () => resolve()));

  const service = createTerminalService({
    settingService: {
      get: async () => ({
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      }),
    } as unknown as ISettingService,
    spawnTerminalProcess: () =>
      ({
        pid: shellChild.pid,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        kill: () => shellChild.kill(),
      }) as unknown as IPty,
  });

  try {
    await service.create({ cols: 80, rows: 24, cwd: process.cwd() });
    assert.equal(
      getPriority(shellChild.pid as number),
      Math.max(parentPriorityBefore, LOW),
      "terminal shell should use idle (19) or keep a lower inherited value",
    );
    assert.equal(getPriority(), parentPriorityBefore);
  } finally {
    service.disposeAll();
    shellChild.kill();
    await shellExited;
  }
});
