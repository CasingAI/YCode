// 早期分派的源码入口验证（docs/specs/windows-bash-process-tree-stop.md）。
//
// `__zcode-job-launcher` 在安装全局 warning 抑制器之前动态加载 adapters 公开入口，
// 该入口会间接执行到 node:sqlite；若把 ExperimentalWarning 留给启动器继承的 stderr，
// 父方会把它当作目标命令的输出捕获。这里直接跑 CLI 源码入口（无 IPC 时启动器按协议
// 直接退出 0），断言 stderr 为空，不接触运行中的 YCode。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runSourceEntry(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveEntry, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(cliRoot, "src/main.ts"), ...args],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveEntry({ code, stderr }));
  });
}

test("job launcher entry exits without leaking bootstrap dependency warnings", async () => {
  const { code, stderr } = await runSourceEntry(["__zcode-job-launcher"]);

  assert.equal(code, 0);
  assert.equal(stderr, "");
});
