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
 * Windows 进程优先级集成测试。
 *
 * 只观察测试自身创建的子进程，不查询、调整或结束任何既有 YCode / 系统进程。
 * 非 Windows 上规则本来就跳过 OS 调用，因此整组用例跳过。
 */

const isWindows = process.platform === "win32";
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

test(
  "Windows agent process is lowered to below normal after spawn",
  { skip: !isWindows },
  async () => {
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
      assert.equal(
        getPriority(managed.pid),
        BELOW_NORMAL,
        "agent child should use BELOW_NORMAL_PRIORITY_CLASS",
      );
      // 只降低子进程，不能连带改变创建方（Host/测试进程）的优先级。
      assert.equal(getPriority(), parentPriorityBefore);
      // 等测试自己创建的子进程退出后再走 manager 的幂等清理，避免测试环境
      // 对存活进程的 taskkill 预算过短导致回收等待。
      await waitFor(() => manager.listManagedProcesses().length === 0, 15_000);
    } finally {
      await manager.disposeAllAndWait();
    }
  },
);

test("Windows git command root is lowered to idle after spawn", { skip: !isWindows }, async () => {
  const provider = createGitCommandProvider({
    platform: "win32",
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
  assert.equal(result.stdout.trim(), String(LOW));
});

test(
  "Windows terminal shell is lowered to idle after pty spawn",
  { skip: !isWindows },
  async () => {
    const parentPriorityBefore = getPriority();
    // 用真实子进程代表 pty shell PID：既验证调用点确实使用了 spawn 返回的 pid，
    // 又不长期持有 node-pty 句柄（测试环境里 ConPTY 清理可能留下运行中句柄）。
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
        LOW,
        "terminal shell should use IDLE_PRIORITY_CLASS",
      );
      assert.equal(getPriority(), parentPriorityBefore);
    } finally {
      service.disposeAll();
      shellChild.kill();
      await shellExited;
    }
  },
);
