// Windows 工具进程优先级（docs/specs/process-priority.md）。
//
// exec 与 MCP 用例在 Windows 上真实创建测试自己的子进程，读回 19（PRIORITY_LOW），
// 并在结束后只回收这些测试进程；父进程优先级必须保持不变。非 Windows 上共享函数
// 不做 OS 调用，因此跳过 OS 断言。
//
// Git 启动点（git-snapshot / agent-worktree / marketplace）的 git 命令短命且没有
// 可注入的 PID 出口，这里用源码连线检查保证「创建 PromiseWithChild 后、await 前」
// 的调用顺序；exec 与 MCP 的真实子进程验证见上面的用例。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import { ProcessTreeStdioClientTransport } from "../src/mcp/stdio-transport.js";

const WINDOWS = process.platform === "win32";
const IDLE = osConstants.priority.PRIORITY_LOW;

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test(
  "execution adapter lowers its spawned tool root to idle priority",
  { skip: !WINDOWS },
  async () => {
    await withTempDir("zcode-priority-exec-", async (outputRootDir) => {
      const adapter = new NodeExecutionAdapter({ outputRootDir });
      const parentPriorityBefore = getPriority(process.pid);
      let observedPidPriority: number | undefined;
      try {
        const result = await adapter.run(
          {
            // 子进程自己读回优先级并输出，避免 test 在进程退出后才读取 PID 的竞态。
            command: {
              mode: "argv",
              file: process.execPath,
              args: [
                "-e",
                "console.log(require('node:os').getPriority(process.pid)); setTimeout(() => {}, 500)",
              ],
            },
            timeoutMs: 15_000,
            trace: { sessionId: "process-priority-test" },
          },
          {
            onEvent: (event) => {
              if (event.type !== "started" || event.pid === undefined) return;
              observedPidPriority = getPriority(event.pid);
            },
          },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.stdout.text.trim(), String(IDLE));
        assert.equal(observedPidPriority, IDLE);
        assert.equal(
          getPriority(process.pid),
          parentPriorityBefore,
          "parent process priority must not change",
        );
      } finally {
        await adapter.close();
      }
    });
  },
);

test(
  "mcp stdio transport lowers the SDK-spawned server to idle priority",
  { skip: !WINDOWS },
  async () => {
    await withTempDir("zcode-priority-mcp-", async (dir) => {
      const serverScript = join(dir, "stdio-server.mjs");
      await writeFile(serverScript, "setInterval(() => {}, 1000);\n", "utf8");
      const transport = new ProcessTreeStdioClientTransport(
        { args: [serverScript], command: process.execPath },
        // Job Object 不是本用例职责；注入空实现避免测试依赖原生能力。
        { windowsJobObjectFactory: async () => undefined },
      );
      const parentPriorityBefore = getPriority(process.pid);
      try {
        await transport.start();
        const pid = transport.pid;
        assert.ok(pid, "MCP transport must expose the spawned pid");
        assert.equal(getPriority(pid), IDLE);
        assert.equal(
          getPriority(process.pid),
          parentPriorityBefore,
          "parent process priority must not change",
        );
      } finally {
        await transport.close();
      }
    });
  },
);

test("git launch sites lower the child pid before awaiting the command", async () => {
  const cases = [
    {
      file: "../src/context/git-snapshot.ts",
      launch: "const pending = execFile(GIT_COMMAND",
    },
    {
      file: "../src/git/agent-worktree.ts",
      launch: 'const pending = execFileAsync("git"',
    },
    {
      file: "../src/plugins/marketplace.ts",
      launch: "const pending = execFileAsync(gitBinary",
    },
  ];

  for (const entry of cases) {
    const source = await readFile(new URL(entry.file, import.meta.url), "utf8");
    const launchIndex = source.indexOf(entry.launch);
    const lowerIndex = source.indexOf(
      'lowerProcessPriority(pending.child.pid, "idle");',
      launchIndex,
    );
    const awaitIndex = source.indexOf("await pending;", launchIndex);

    assert.ok(launchIndex >= 0, `${entry.file}: expected exec launch ${entry.launch}`);
    assert.ok(lowerIndex > launchIndex, `${entry.file}: lowerProcessPriority must follow launch`);
    assert.ok(awaitIndex > lowerIndex, `${entry.file}: lowerProcessPriority must precede await`);
  }
});
