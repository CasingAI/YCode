// CLI 受管 headless Chromium 的优先级（docs/specs/process-priority.md）。
//
// 这里只用 fake Playwright：真实浏览器进程的创建、CDP 连接和页面导航不在单测里做，
// 也不连接或操作正在运行的 YCode。用例验证公开 API 的顺序：launchServer 返回 ->
// BrowserServer.process() 的根 PID 设 idle -> connect -> context/page。
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import type { ProcessPriority, ProcessPriorityResult } from "@zcode/shared/node";
import type { Browser, BrowserServer } from "playwright-core";
import {
  createManagedCdpBrowserRuntime,
  type BrowserLaunchHost,
  type ManagedCdpBrowserRuntimeOptions,
  type PlaywrightChromiumModule,
} from "../src/browser/index.js";

interface FakeLaunchOptions {
  executablePath?: string;
  headless?: boolean;
  host?: string;
  args?: string[];
}

interface FakePlaywrightOptions {
  failConnect?: boolean;
  forbidLaunch?: boolean;
  pid?: number;
  onLaunch?: (options: FakeLaunchOptions) => void;
  launchGate?: Promise<void>;
  serverCloseGate?: Promise<void>;
  contextFailures?: number;
}

function createFakePlaywright(events: string[], options: FakePlaywrightOptions = {}) {
  const listeners: Array<() => void> = [];
  let connected = true;
  let serverCloseCount = 0;
  let remainingContextFailures = options.contextFailures ?? 0;
  const disconnect = () => {
    connected = false;
    for (const listener of listeners) listener();
  };
  const server = {
    process: () => ({ pid: "pid" in options ? options.pid : 4321 }),
    wsEndpoint: () => "ws://127.0.0.1:9/fake-browser",
    close: async () => {
      serverCloseCount += 1;
      events.push("server.close");
      await options.serverCloseGate;
    },
  } as unknown as BrowserServer;
  const context = {
    pages: () => [],
    on: () => context,
    close: async () => {
      events.push("context.close");
    },
    browser: () => browser,
  };
  const browser = {
    isConnected: () => connected,
    on: (_event: string, listener: () => void) => {
      listeners.push(listener);
      return browser;
    },
    newContext: async () => {
      events.push("newContext");
      if (remainingContextFailures > 0) {
        remainingContextFailures -= 1;
        throw new Error("fake context failure");
      }
      return context;
    },
    close: async () => {
      events.push("browser.close");
      disconnect();
    },
  } as unknown as Browser;

  const module = {
    chromium: {
      launchServer: async (launchOptions: FakeLaunchOptions) => {
        events.push("launchServer");
        if (options.forbidLaunch) {
          throw new Error("the parent process must not call launchServer on Linux");
        }
        options.onLaunch?.(launchOptions);
        await options.launchGate;
        return server;
      },
      connect: async () => {
        events.push("connect");
        if (options.failConnect) throw new Error("fake connect failure");
        return browser;
      },
    },
  } as unknown as PlaywrightChromiumModule;

  return { module, browser, server, disconnect, getServerCloseCount: () => serverCloseCount };
}

function createRuntime(
  module: PlaywrightChromiumModule,
  events: string[],
  lowerPriority?: (
    pid: number | null | undefined,
    priority: ProcessPriority,
  ) => ProcessPriorityResult,
  options: Partial<ManagedCdpBrowserRuntimeOptions> = {},
) {
  return createManagedCdpBrowserRuntime({
    executablePath: process.execPath,
    // 这些用例验证进程内路径（launchServer + 根 PID）；显式固定平台，避免在 Linux CI 上走宿主分支。
    platform: "win32",
    loadPlaywright: async () => module,
    closeTimeoutMs: 200,
    lowerPriority: (pid, priority) => {
      events.push(`priority:${String(pid)}:${priority}`);
      return lowerPriority?.(pid, priority) ?? "applied";
    },
    ...options,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("managed CDP browser lowers the root browser process to idle before connecting", async () => {
  const events: string[] = [];
  let launchOptions: FakeLaunchOptions | undefined;
  const { module, browser } = createFakePlaywright(events, {
    onLaunch: (options) => {
      launchOptions = options;
    },
  });
  const runtime = createRuntime(module, events);

  try {
    await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });

    assert.deepEqual(events.slice(0, 3), ["launchServer", "priority:4321:idle", "connect"]);
    assert.equal(launchOptions?.executablePath, process.execPath);
    assert.equal(launchOptions?.headless, true);
    assert.equal(launchOptions?.host, "127.0.0.1");
    assert.deepEqual(launchOptions?.args, ["--no-first-run", "--no-default-browser-check"]);
    // Playwright 的 Browser 没有公开 process()；只有 BrowserServer 有。
    assert.equal("process" in browser, false);
  } finally {
    await runtime.close();
  }
});

test("contexts are created only after the browser root is lowered and connected", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events);
  const runtime = createRuntime(module, events);

  try {
    const [backend] = await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
    const result = await runtime.browserControlPort.execute({
      browserId: backend.id,
      browserGeneration: backend.generation,
      sessionId: "browser-priority-test",
      command: { method: "list" },
    });

    assert.equal(result.ok, true);
    const priorityIndex = events.indexOf("priority:4321:idle");
    const connectIndex = events.indexOf("connect");
    const contextIndex = events.indexOf("newContext");
    assert.ok(priorityIndex >= 0 && priorityIndex < connectIndex);
    assert.ok(contextIndex > connectIndex, "context creation must happen after connect");
  } finally {
    await runtime.close();
  }
});

test("closing the managed CDP runtime closes the connection and the browser server", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events);
  const runtime = createRuntime(module, events);

  await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
  events.length = 0;
  await runtime.close();

  const browserCloseIndex = events.indexOf("browser.close");
  const serverCloseIndex = events.indexOf("server.close");
  assert.ok(browserCloseIndex >= 0, "browser connection must be closed");
  assert.ok(
    serverCloseIndex > browserCloseIndex,
    "browser server must be closed after the connection",
  );
});

test("unexpected browser disconnect closes the launched browser server", async () => {
  const events: string[] = [];
  const { module, disconnect } = createFakePlaywright(events);
  const runtime = createRuntime(module, events);

  try {
    await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
    events.length = 0;
    disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.includes("server.close"), "disconnected browser must not leak its server");
  } finally {
    await runtime.close();
  }
});

test("connect failure closes the already launched browser server", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { failConnect: true });
  const runtime = createRuntime(module, events);

  try {
    await assert.rejects(
      runtime.browserControlPort.list({ sessionId: "browser-priority-test" }),
      /launch failed/,
    );
    assert.ok(events.includes("priority:4321:idle"), "priority is applied before connect");
    assert.ok(
      events.includes("server.close"),
      "launched server must be closed after connect failure",
    );
  } finally {
    await runtime.close();
  }
});

test("a late launch after bounded close still closes its server exactly once", async () => {
  const events: string[] = [];
  let releaseLaunch!: () => void;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  const { module, getServerCloseCount } = createFakePlaywright(events, { launchGate });
  const runtime = createRuntime(module, events);

  // 先挂 rejection 处理，避免迟到 launch 在测试等待期间形成 unhandled rejection。
  const listing = runtime.browserControlPort.list({ sessionId: "browser-priority-test" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitFor(() => events.includes("launchServer"));
  await runtime.close();
  assert.equal(getServerCloseCount(), 0);

  releaseLaunch();
  await waitFor(() => getServerCloseCount() === 1);
  const listingError = await listing;
  assert.ok(listingError instanceof Error && /closed/u.test(listingError.message));
  assert.equal(getServerCloseCount(), 1, "late launch must not double-close the server");
});

test("intentional close waits for an in-flight disconnect cleanup without double closing", async () => {
  const events: string[] = [];
  let releaseServerClose!: () => void;
  const serverCloseGate = new Promise<void>((resolve) => {
    releaseServerClose = resolve;
  });
  const { module, disconnect, getServerCloseCount } = createFakePlaywright(events, {
    serverCloseGate,
  });
  const runtime = createRuntime(module, events);

  await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
  disconnect();
  await waitFor(() => getServerCloseCount() === 1);

  let closed = false;
  const closing = runtime.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false, "close must wait for in-flight server cleanup");

  releaseServerClose();
  await closing;
  assert.equal(getServerCloseCount(), 1, "disconnect and close must share one cleanup path");
});

test("cancelled request does not launch the browser", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events);
  const runtime = createRuntime(module, events);
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(
      runtime.browserControlPort.list({
        sessionId: "browser-priority-test",
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.deepEqual(events, [], "cancelled request must not launch the browser");
  } finally {
    await runtime.close();
  }
});

test("session creation retries after a context failure", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { contextFailures: 1 });
  const runtime = createRuntime(module, events);

  try {
    const [backend] = await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
    const input = {
      browserId: backend.id,
      browserGeneration: backend.generation,
      sessionId: "browser-priority-test",
      command: { method: "list" as const },
    };
    const failed = await runtime.browserControlPort.execute(input);
    const retried = await runtime.browserControlPort.execute(input);

    assert.equal(failed.ok, false);
    assert.equal(retried.ok, true);
    assert.equal(events.filter((event) => event === "newContext").length, 2);
  } finally {
    await runtime.close();
  }
});

test("closeSession closes its context and then the browser server", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events);
  const runtime = createRuntime(module, events);

  try {
    const [backend] = await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
    await runtime.browserControlPort.execute({
      browserId: backend.id,
      browserGeneration: backend.generation,
      sessionId: "browser-priority-test",
      command: { method: "list" },
    });
    events.length = 0;
    await runtime.browserControlPort.closeSession({ sessionId: "browser-priority-test" });

    assert.ok(events.includes("context.close"));
    assert.ok(events.includes("browser.close"));
    assert.ok(events.includes("server.close"));
  } finally {
    await runtime.close();
  }
});

test("missing browser root pid skips priority without blocking connect", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { pid: undefined });
  const runtime = createRuntime(module, events);

  try {
    await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
    assert.deepEqual(events.slice(0, 3), ["launchServer", "priority:undefined:idle", "connect"]);
  } finally {
    await runtime.close();
  }
});

interface FakeHostOptions {
  fail?: boolean;
  hostGate?: Promise<void>;
}

function createLinuxRuntime(
  module: PlaywrightChromiumModule,
  events: string[],
  hostOptions: FakeHostOptions = {},
) {
  let hostCloseCount = 0;
  const host: BrowserLaunchHost = {
    wsEndpoint: "ws://127.0.0.1:9/fake-host",
    close: async () => {
      hostCloseCount += 1;
      events.push("host.close");
    },
  };
  const runtime = createManagedCdpBrowserRuntime({
    executablePath: process.execPath,
    platform: "linux",
    loadPlaywright: async () => module,
    closeTimeoutMs: 200,
    launchHost: async (context) => {
      events.push(`launchHost:${context.executablePath ?? "auto"}:${context.args.join(" ")}`);
      if (hostOptions.fail) throw new Error("fake host failure");
      await hostOptions.hostGate;
      return host;
    },
  });
  return { runtime, host, getHostCloseCount: () => hostCloseCount };
}

test("linux launches in an idle host and never calls launchServer in the parent", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { forbidLaunch: true });
  const { runtime } = createLinuxRuntime(module, events);

  try {
    const [backend] = await runtime.browserControlPort.list({
      sessionId: "browser-priority-test",
    });
    const result = await runtime.browserControlPort.execute({
      browserId: backend.id,
      browserGeneration: backend.generation,
      sessionId: "browser-priority-test",
      command: { method: "list" },
    });

    assert.equal(result.ok, true);
    const hostIndex = events.findIndex((event) => event.startsWith("launchHost:"));
    const connectIndex = events.indexOf("connect");
    const contextIndex = events.indexOf("newContext");
    assert.ok(hostIndex >= 0, "linux must spawn the idle launch host");
    assert.ok(hostIndex < connectIndex, "the host must be ready before connect");
    assert.ok(contextIndex > connectIndex, "context creation must happen after connect");
    assert.equal(events.includes("launchServer"), false);
    assert.equal(
      events.some((event) => event.startsWith("priority:")),
      false,
      "the parent must not set the host browser root pid",
    );
    assert.match(
      events[hostIndex] ?? "",
      /^launchHost:.*--no-first-run --no-default-browser-check$/,
    );
  } finally {
    await runtime.close();
  }
});

test("linux closes the idle host after the browser connection", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { forbidLaunch: true });
  const { runtime, getHostCloseCount } = createLinuxRuntime(module, events);

  const [backend] = await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
  await runtime.browserControlPort.execute({
    browserId: backend.id,
    browserGeneration: backend.generation,
    sessionId: "browser-priority-test",
    command: { method: "list" },
  });
  events.length = 0;
  await runtime.close();

  const browserCloseIndex = events.indexOf("browser.close");
  const hostCloseIndex = events.indexOf("host.close");
  assert.ok(browserCloseIndex >= 0, "browser connection must be closed");
  assert.ok(hostCloseIndex > browserCloseIndex, "host must be closed after the connection");
  assert.equal(getHostCloseCount(), 1);
});

test("linux connect failure closes the already started idle host", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { failConnect: true, forbidLaunch: true });
  const { runtime, getHostCloseCount } = createLinuxRuntime(module, events);

  try {
    await assert.rejects(
      runtime.browserControlPort.list({ sessionId: "browser-priority-test" }),
      /launch failed/,
    );
    assert.equal(getHostCloseCount(), 1, "connect failure must not leak the host");
  } finally {
    await runtime.close();
  }
});

test("linux unexpected disconnect closes the idle host", async () => {
  const events: string[] = [];
  const { module, disconnect } = createFakePlaywright(events, { forbidLaunch: true });
  const { runtime, getHostCloseCount } = createLinuxRuntime(module, events);

  try {
    await runtime.browserControlPort.list({ sessionId: "browser-priority-test" });
    events.length = 0;
    disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getHostCloseCount(), 1, "disconnected browser must not leak its host");
  } finally {
    await runtime.close();
  }
});

test("linux host failure is reported as a launch failure without connecting", async () => {
  const events: string[] = [];
  const { module } = createFakePlaywright(events, { forbidLaunch: true });
  const { runtime } = createLinuxRuntime(module, events, { fail: true });

  try {
    await assert.rejects(
      runtime.browserControlPort.list({ sessionId: "browser-priority-test" }),
      /launch failed/,
    );
    assert.equal(events.includes("connect"), false, "the parent must not connect after host failure");
  } finally {
    await runtime.close();
  }
});

test("linux late host launch after bounded close still closes the host exactly once", async () => {
  const events: string[] = [];
  let releaseHost!: () => void;
  const hostGate = new Promise<void>((resolve) => {
    releaseHost = resolve;
  });
  const { module } = createFakePlaywright(events, { forbidLaunch: true });
  const { runtime, getHostCloseCount } = createLinuxRuntime(module, events, { hostGate });

  const listing = runtime.browserControlPort.list({ sessionId: "browser-priority-test" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitFor(() => events.some((event) => event.startsWith("launchHost:")));
  await runtime.close();
  assert.equal(getHostCloseCount(), 0);

  releaseHost();
  await waitFor(() => getHostCloseCount() === 1);
  const listingError = await listing;
  assert.ok(listingError instanceof Error && /closed/u.test(listingError.message));
  assert.equal(getHostCloseCount(), 1, "late host launch must not double-close");
});
