// Linux CLI 受管浏览器的 idle 启动宿主（docs/specs/process-priority.md）。
//
// 这里只注入 fake Playwright 和内存 stdin/stdout，不创建真实浏览器、不连接正在运行的
// YCode，也不使用 CDP/DevTools/UI 自动化。用例验证宿主在加载 Playwright 之前同步自降，
// 以及 ready/error/close/EOF/迟到 launch 的协议和清理顺序。
import assert from "node:assert/strict";
import process from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ProcessPriority, ProcessPriorityResult } from "@zcode/shared/process-priority";
import type { BrowserServer } from "playwright-core";
import type { RunContext } from "@zcode/shared-types";
import {
  runBrowserHostCommand,
  type BrowserHostDependencies,
} from "../src/browser-host-command.js";
import type { PlaywrightChromiumModule } from "@zcode/adapters/browser";

interface FakeLaunchOptions {
  executablePath?: string;
  headless?: boolean;
  host?: string;
  args?: string[];
}

interface FakePlaywrightOptions {
  failLaunch?: boolean;
  launchGate?: Promise<void>;
  serverCloseGate?: Promise<void>;
  onLaunch?: (options: FakeLaunchOptions) => void;
  onServerKill?: () => void;
}

function createFakePlaywright(events: string[], options: FakePlaywrightOptions = {}) {
  let serverCloseCount = 0;
  let serverKillCount = 0;
  let processKillCount = 0;
  const server = {
    wsEndpoint: () => "ws://127.0.0.1:9/fake-host",
    kill: () => {
      serverKillCount += 1;
      events.push("server.kill");
      options.onServerKill?.();
      return Promise.resolve();
    },
    process: () => ({
      kill: (signal: NodeJS.Signals) => {
        processKillCount += 1;
        events.push(`server.kill:${signal}`);
        return true;
      },
    }),
    close: async () => {
      serverCloseCount += 1;
      events.push("server.close");
      await options.serverCloseGate;
    },
  } as unknown as BrowserServer;
  const module = {
    chromium: {
      executablePath: () => process.execPath,
      launchServer: async (launchOptions: FakeLaunchOptions) => {
        events.push("launchServer");
        options.onLaunch?.(launchOptions);
        await options.launchGate;
        if (options.failLaunch) {
          throw new Error("secret /tmp/profile/cdp-endpoint");
        }
        return server;
      },
    },
  } as unknown as PlaywrightChromiumModule;

  return {
    module,
    getServerCloseCount: () => serverCloseCount,
    getServerKillCount: () => serverKillCount,
    getProcessKillCount: () => processKillCount,
  };
}

function createHostContext(options: { stdoutWriteThrows?: boolean } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines: string[] = [];
  let buffer = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  stderr.resume();
  if (options.stdoutWriteThrows) {
    (stdout as unknown as { write: () => boolean }).write = () => {
      throw new Error("EPIPE");
    };
  }

  const ctx = {
    argv: [],
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
  } satisfies RunContext;

  return { ctx, lines, stdin, stdout };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createDependencies(
  events: string[],
  module: PlaywrightChromiumModule,
  lower?: (pid: number, priority: ProcessPriority) => ProcessPriorityResult,
): BrowserHostDependencies {
  return {
    loadPlaywright: async () => {
      events.push("loadPlaywright");
      return module;
    },
    lower: (pid, priority) => {
      events.push(`priority:${pid}:${priority}`);
      return lower?.(pid, priority) ?? "applied";
    },
  };
}

test("browser host lowers itself to idle before loading Playwright and launching", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events);
  const { ctx, lines, stdin } = createHostContext();
  const running = runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  await waitFor(() => lines.length > 0);
  assert.deepEqual(events.slice(0, 3), [
    `priority:${process.pid}:idle`,
    "loadPlaywright",
    "launchServer",
  ]);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    type: "ready",
    wsEndpoint: "ws://127.0.0.1:9/fake-host",
  });

  stdin.end();
  assert.equal(await running, 0);
});

test("browser host launches a headless loopback server", async () => {
  const events: string[] = [];
  let launchOptions: FakeLaunchOptions | undefined;
  const { module } = createFakePlaywright(events, {
    onLaunch: (options) => {
      launchOptions = options;
    },
  });
  const { ctx, lines, stdin } = createHostContext();
  const running = runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  await waitFor(() => lines.length > 0);
  assert.equal(launchOptions?.executablePath, process.execPath);
  assert.equal(launchOptions?.headless, true);
  assert.equal(launchOptions?.host, "127.0.0.1");
  assert.deepEqual(launchOptions?.args, ["--no-first-run", "--no-default-browser-check"]);

  stdin.end();
  await running;
});

test("browser host closes its server exactly once on a close request", async () => {
  const events: string[] = [];
  const { module, getServerCloseCount } = createFakePlaywright(events);
  const { ctx, lines, stdin } = createHostContext();
  const running = runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  await waitFor(() => lines.length > 0);
  stdin.write('{"type":"close"}\n');
  assert.equal(await running, 0);
  assert.equal(getServerCloseCount(), 1);
});

test("browser host closes its server when the parent closes stdin", async () => {
  const events: string[] = [];
  const { module, getServerCloseCount } = createFakePlaywright(events);
  const { ctx, lines, stdin } = createHostContext();
  const running = runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  await waitFor(() => lines.length > 0);
  stdin.end();
  assert.equal(await running, 0);
  assert.equal(getServerCloseCount(), 1);
});

test("browser host reports a sanitized launch failure", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { failLaunch: true });
  const { ctx, lines } = createHostContext();
  const code = await runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  const message = JSON.parse(lines[0] ?? "") as { type?: string; message?: string };
  assert.equal(message.type, "error");
  assert.equal(typeof message.message, "string");
  assert.doesNotMatch(message.message ?? "", /secret|\/tmp\/profile/u);
});

test("browser host closes a server whose launch finishes after a close request", async () => {
  const events: string[] = [];
  let releaseLaunch!: () => void;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  const { module, getServerCloseCount } = createFakePlaywright(events, { launchGate });
  const { ctx, lines, stdin } = createHostContext();
  const running = runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  await waitFor(() => events.includes("launchServer"));
  stdin.write('{"type":"close"}\n');
  releaseLaunch();
  assert.equal(await running, 0);
  assert.equal(getServerCloseCount(), 1);
  assert.deepEqual(lines, [], "a closed host must not report ready after a late launch");
});

test("browser host does not launch when close arrives during Playwright loading", async () => {
  const events: string[] = [];
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const { module, getServerCloseCount } = createFakePlaywright(events);
  const { ctx, lines, stdin } = createHostContext();
  const deps: BrowserHostDependencies = {
    loadPlaywright: async () => {
      events.push("loadPlaywright");
      await loadGate;
      return module;
    },
    lower: () => "applied",
  };
  const running = runBrowserHostCommand(ctx, [JSON.stringify({})], deps);

  await waitFor(() => events.includes("loadPlaywright"));
  stdin.write('{"type":"close"}\n');
  releaseLoad();

  assert.equal(await running, 0);
  assert.equal(events.includes("launchServer"), false, "a closed host must not create a browser");
  assert.equal(getServerCloseCount(), 0);
  assert.deepEqual(lines, []);
});

test("browser host closes its server when the ready write fails synchronously", async () => {
  const events: string[] = [];
  const { module, getServerCloseCount } = createFakePlaywright(events);
  const { ctx } = createHostContext({ stdoutWriteThrows: true });
  const code = await runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  assert.equal(code, 1);
  assert.equal(getServerCloseCount(), 1);
});

test("browser host treats an asynchronous stdout error as a close request", async () => {
  const events: string[] = [];
  let releaseLaunch!: () => void;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  const { module, getServerCloseCount } = createFakePlaywright(events, { launchGate });
  const { ctx, lines, stdout } = createHostContext();
  const running = runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath })],
    createDependencies(events, module),
  );

  await waitFor(() => events.includes("launchServer"));
  stdout.emit("error", new Error("EPIPE"));
  releaseLaunch();

  assert.equal(await running, 0);
  assert.equal(getServerCloseCount(), 1);
  assert.deepEqual(lines, [], "an output error must suppress a late ready message");
});

test("browser host watchdog kills its own BrowserServer process group before exiting", async () => {
  const events: string[] = [];
  let releaseServerClose!: () => void;
  const serverCloseGate = new Promise<void>((resolve) => {
    releaseServerClose = resolve;
  });
  const { module, getServerKillCount, getProcessKillCount } = createFakePlaywright(events, {
    serverCloseGate,
    onServerKill: () => {
      releaseServerClose();
    },
  });
  const { ctx, lines, stdin } = createHostContext();
  const exits: number[] = [];
  const deps: BrowserHostDependencies = {
    ...createDependencies(events, module),
    exit: (code) => {
      exits.push(code);
    },
  };
  const running = runBrowserHostCommand(
    ctx,
    [JSON.stringify({ executablePath: process.execPath, closeTimeoutMs: 30 })],
    deps,
  );

  await waitFor(() => lines.length > 0);
  stdin.write('{"type":"close"}\n');
  await waitFor(() => getServerKillCount() > 0, 2_000);
  releaseServerClose();

  assert.equal(await running, 0);
  // 公开 BrowserServer.kill() 负责整个浏览器进程组；不再回退到只杀根 PID 的 process().kill。
  assert.equal(getServerKillCount(), 1);
  assert.equal(getProcessKillCount(), 0);
  assert.ok(events.includes("server.kill"));
  assert.ok(events.includes("server.close"));
  assert.deepEqual(exits, [0]);
});
