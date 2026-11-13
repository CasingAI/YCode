// Linux 浏览器 idle 宿主的父侧协议（docs/specs/process-priority.md）。
//
// 这里只注入 fake ChildProcess 或自建短命 Node 进程，不启动浏览器、不连接正在运行的
// YCode，也不使用 CDP/DevTools/UI 自动化。用例验证 ready/error/exit/无效消息/超时/
// close/重复 close/EOF 的握手与有界清理，以及 SEA 与开发态自 re-exec 参数。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ZCODE_BROWSER_HOST_COMMAND } from "@zcode/contracts";
import {
  filterBrowserHostExecArgv,
  resolveBrowserLaunchHostCommand,
  spawnBrowserLaunchHost,
  type BrowserLaunchHostRuntime,
  type SpawnBrowserLaunchHostOptions,
} from "../src/browser/launch-host.js";

const execFileAsync = promisify(execFile);

const DEV_RUNTIME: BrowserLaunchHostRuntime = {
  execPath: "/usr/local/bin/node",
  execArgv: ["--enable-source-maps"],
  argv1: "/repo/apps/zcode-cli/packages/cli/src/main.ts",
  isSea: false,
};

class CaptureWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new CaptureWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    return true;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function asChild(child: FakeChildProcess) {
  return child as unknown as import("node:child_process").ChildProcessWithoutNullStreams;
}

function createSpawn(child: FakeChildProcess) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args });
    return asChild(child);
  };
  return { calls, spawn };
}

function options(
  spawn: SpawnBrowserLaunchHostOptions["spawn"],
  overrides: Partial<SpawnBrowserLaunchHostOptions> = {},
): SpawnBrowserLaunchHostOptions {
  return {
    closeTimeoutMs: 50,
    readyTimeoutMs: 100,
    spawn,
    runtime: DEV_RUNTIME,
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("spawn resolves a ready host and sends a close line on close", async () => {
  const child = new FakeChildProcess();
  const { calls, spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost(
    { executablePath: "/opt/chromium", args: ["--no-first-run"] },
    options(spawn),
  );

  child.stdout.write(`${JSON.stringify({ type: "ready", wsEndpoint: "ws://127.0.0.1:9/x" })}\n`);
  const host = await pending;
  assert.equal(host.wsEndpoint, "ws://127.0.0.1:9/x");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, DEV_RUNTIME.execPath);
  assert.deepEqual(calls[0]?.args.slice(0, 2), [
    DEV_RUNTIME.execArgv[0],
    resolve(DEV_RUNTIME.argv1 ?? ""),
  ]);
  assert.equal(calls[0]?.args[2], ZCODE_BROWSER_HOST_COMMAND);
  const payload = JSON.parse(calls[0]?.args[3] ?? "") as Record<string, unknown>;
  assert.equal(payload.executablePath, "/opt/chromium");
  assert.deepEqual(payload.args, ["--no-first-run"]);
  assert.equal(payload.closeTimeoutMs, 50);

  const closing = host.close();
  assert.equal(child.stdin.chunks.filter((chunk) => chunk.includes('"close"')).length, 1);
  child.exit(0);
  await closing;
});

test("a host error message rejects without waiting for ready", async () => {
  const child = new FakeChildProcess();
  const { spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost({ args: [] }, options(spawn));

  child.stdout.write(`${JSON.stringify({ type: "error", message: "host failed" })}\n`);
  await assert.rejects(pending, /host failed/);
  await waitFor(() => child.kills.includes("SIGKILL"));
  assert.equal(child.stdin.chunks.filter((chunk) => chunk.includes('"close"')).length, 1);
});

test("an exit before ready rejects and does not force kill an exited host", async () => {
  const child = new FakeChildProcess();
  const { spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost({ args: [] }, options(spawn));

  child.exit(1);
  await assert.rejects(pending, /exited before it was ready/);
  assert.deepEqual(child.kills, []);
});

test("invalid messages are ignored and the ready timeout force kills the host", async () => {
  const child = new FakeChildProcess();
  const { spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost({ args: [] }, options(spawn, { readyTimeoutMs: 30 }));

  child.stdout.write("not-json\n");
  await assert.rejects(pending, /did not become ready in time/);
  await waitFor(() => child.kills.includes("SIGKILL"));
  assert.equal(child.stdin.chunks.filter((chunk) => chunk.includes('"close"')).length, 1);
});

test("close is idempotent and only sends one close line", async () => {
  const child = new FakeChildProcess();
  const { spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost({ args: [] }, options(spawn));
  child.stdout.write(`${JSON.stringify({ type: "ready", wsEndpoint: "ws://127.0.0.1:9/x" })}\n`);
  const host = await pending;

  const first = host.close();
  const second = host.close();
  assert.equal(first, second);
  assert.equal(child.stdin.chunks.filter((chunk) => chunk.includes('"close"')).length, 1);
  child.exit(0);
  await Promise.all([first, second]);
});

test("close after the host already exited resolves without another kill", async () => {
  const child = new FakeChildProcess();
  const { spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost({ args: [] }, options(spawn));
  child.stdout.write(`${JSON.stringify({ type: "ready", wsEndpoint: "ws://127.0.0.1:9/x" })}\n`);
  const host = await pending;

  child.exit(0);
  await host.close();
  assert.deepEqual(child.kills, []);
});

test("close force kills only its own host when graceful exit times out", async () => {
  const child = new FakeChildProcess();
  const { spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost({ args: [] }, options(spawn));
  child.stdout.write(`${JSON.stringify({ type: "ready", wsEndpoint: "ws://127.0.0.1:9/x" })}\n`);
  const host = await pending;

  await host.close();
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("a spawn throw is reported as a host startup failure", async () => {
  await assert.rejects(
    spawnBrowserLaunchHost(
      { args: [] },
      options(() => {
        throw new Error("spawn exploded");
      }),
    ),
    /Failed to start the browser launch host/,
  );
});

test("a stdout error before ready rejects and cleans up", async () => {
  const child = new FakeChildProcess();
  const { spawn } = createSpawn(child);
  const pending = spawnBrowserLaunchHost({ args: [] }, options(spawn));

  child.stdout.emit("error", new Error("EPIPE"));
  await assert.rejects(pending, /Failed to start the browser launch host/);
  await waitFor(() => child.kills.includes("SIGKILL"));
});

test("SEA self re-exec uses only the executable and the internal command", () => {
  const command = resolveBrowserLaunchHostCommand(
    { args: ["--no-first-run"] },
    {
      closeTimeoutMs: 1_500,
      runtime: {
        execPath: "/opt/zcode",
        execArgv: ["--inspect=9229"],
        argv1: "/opt/zcode",
        isSea: true,
      },
    },
  );

  assert.equal(command.command, "/opt/zcode");
  assert.equal(command.args[0], ZCODE_BROWSER_HOST_COMMAND);
  assert.equal(command.args.length, 2);
  assert.equal(JSON.parse(command.args[1] ?? "").closeTimeoutMs, 1_500);
});

test("development self re-exec keeps the entrypoint and filters inspector flags", () => {
  const command = resolveBrowserLaunchHostCommand(
    { executablePath: "/opt/chromium", args: [] },
    {
      closeTimeoutMs: 1_500,
      runtime: {
        execPath: "/usr/local/bin/node",
        execArgv: [
          "--inspect",
          "--inspect-brk",
          "--inspect=9229",
          "--inspect-brk=9230",
          "--inspect-wait",
          "--max-old-space-size=256",
          "--enable-source-maps",
        ],
        argv1: "/repo/main.ts",
        isSea: false,
      },
    },
  );

  assert.deepEqual(command.args.slice(0, 2), ["--max-old-space-size=256", "--enable-source-maps"]);
  assert.equal(command.args[2], resolve("/repo/main.ts"));
  assert.equal(command.args[3], ZCODE_BROWSER_HOST_COMMAND);
});

test("filterBrowserHostExecArgv removes inspect variants but keeps other flags", () => {
  assert.deepEqual(
    filterBrowserHostExecArgv([
      "--inspect",
      "--inspect-brk",
      "--inspect=1",
      "--inspect-brk=1",
      "--inspect-wait",
      "--max-old-space-size=128",
    ]),
    ["--max-old-space-size=128"],
  );
});

test("development self re-exec requires an entrypoint", () => {
  assert.throws(
    () =>
      resolveBrowserLaunchHostCommand(
        { args: [] },
        {
          closeTimeoutMs: 1_500,
          runtime: {
            execPath: "/usr/local/bin/node",
            execArgv: [],
            argv1: undefined,
            isSea: false,
          },
        },
      ),
    /entrypoint/,
  );
});

test("a real short-lived Node host completes the ready and close round trip", async () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/browser-launch-host-roundtrip.mjs", import.meta.url),
  );
  const { stdout } = await execFileAsync(process.execPath, [fixture], { timeout: 20_000 });
  const result = JSON.parse(stdout) as { endpoint?: string; closed?: boolean };

  assert.equal(result.endpoint, "ws://127.0.0.1:9/roundtrip");
  assert.equal(result.closed, true);
});

test("a real host that closes stdout before ready rejects without an unhandled error", async () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/browser-launch-host-roundtrip.mjs", import.meta.url),
  );
  await assert.rejects(
    spawnBrowserLaunchHost(
      { args: ["close-stdout"] },
      {
        closeTimeoutMs: 100,
        readyTimeoutMs: 5_000,
        runtime: {
          execPath: process.execPath,
          execArgv: [],
          argv1: fixture,
          isSea: false,
        },
      },
    ),
    /exited before it was ready/,
  );
});
