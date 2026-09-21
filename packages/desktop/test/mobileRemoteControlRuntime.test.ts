import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import type { MobileRemoteControlStatus } from "@zcode/services";
import { createMemoryMobileRemoteControlStateStore } from "@zcode/services/node";
import { createMobileRemoteControlRuntime } from "../src/host/mobileRemoteControlService.js";
import type { MobileRemoteControlStateStore } from "@zcode/services/node";

const TOKEN_COOKIE = "zcode_lite_token";

let webRoot: string;

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function createRuntime(
  options: { webRoot?: string | undefined; stateStore?: MobileRemoteControlStateStore } = {},
) {
  return createMobileRemoteControlRuntime({
    getServices: () => new ServiceCollection(),
    resolveWebRoot: () => ("webRoot" in options ? options.webRoot : webRoot),
    // 真机上是 Host 的 attachment overrides；这里只验证连接被建立与释放。
    exposeServices: () => () => undefined,
    logger: silentLogger,
    logRpc: () => undefined,
    // 默认注入内存落盘，任何用例都不许碰真实数据目录。
    stateStore: options.stateStore ?? createMemoryMobileRemoteControlStateStore(),
  });
}

/** 轮询等待状态满足条件；远控状态由异步连接事件驱动，不能用同步断言。 */
async function waitForStatus(
  runtime: { service: { getStatus(): Promise<MobileRemoteControlStatus> } },
  predicate: (status: MobileRemoteControlStatus) => boolean,
  timeoutMs = 5000,
): Promise<MobileRemoteControlStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await runtime.service.getStatus();
    if (predicate(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for status, last=${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function connectWebSocket(url: string, cookieToken: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { cookie: `${TOKEN_COOKIE}=${cookieToken}` },
    });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`handshake rejected: ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

/** accessUrl 一定带 token，取出来给 401/200 断言用。 */
function tokenOf(accessUrl: string | undefined): string {
  assert.ok(accessUrl, "accessUrl 缺失");
  const token = new URL(accessUrl).searchParams.get("token");
  assert.ok(token, "accessUrl 缺少 token");
  return token;
}

before(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-root-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>mobile</title>");
});

after(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

describe("mobile remote control runtime", () => {
  it("未构建 web 产物时进入 error 且不监听端口", async () => {
    const runtime = createRuntime({ webRoot: join(webRoot, "does-not-exist") });
    try {
      const status = await runtime.service.start();
      assert.equal(status.state, "error");
      assert.equal(status.errorCode, "web-root-missing");
      assert.equal(status.port, undefined);
      assert.equal(status.accessUrl, undefined);
      // 没开成功就不能落成"已启用"，否则下次启动会一直重试一个必然失败的动作。
      assert.equal(status.enabled, false);
    } finally {
      runtime.dispose();
    }
  });

  it("没有 Host services 时返回 error", async () => {
    const runtime = createMobileRemoteControlRuntime({
      getServices: () => null,
      resolveWebRoot: () => webRoot,
      exposeServices: () => () => undefined,
      logger: silentLogger,
      logRpc: () => undefined,
      stateStore: createMemoryMobileRemoteControlStateStore(),
    });
    try {
      const status = await runtime.service.start();
      assert.equal(status.state, "error");
      assert.equal(status.errorCode, "start-failed");
    } finally {
      runtime.dispose();
    }
  });

  it("start 后进入 running 并落盘用户意图，重复 start 不换端口与 token", async () => {
    const stateStore = createMemoryMobileRemoteControlStateStore();
    const runtime = createRuntime({ stateStore });
    try {
      const first = await runtime.service.start({ workspacePath: "/tmp/demo-project" });
      assert.equal(first.state, "running");
      assert.equal(first.enabled, true);
      assert.ok(first.port && first.port > 0);
      assert.ok(first.accessUrl?.startsWith(`http://`));
      assert.ok(first.accessUrl?.includes("?token="));
      assert.equal(first.connectedClients, 0);

      const persisted = await stateStore.read();
      assert.equal(persisted?.enabled, true);
      assert.equal(persisted?.port, first.port);
      assert.equal(persisted?.token, tokenOf(first.accessUrl));

      const second = await runtime.service.start();
      assert.equal(second.port, first.port);
      assert.equal(second.accessUrl, first.accessUrl);
    } finally {
      runtime.dispose();
    }
  });

  it("stop 幂等，端口与 token 固定：再次开启回到同一个链接", async () => {
    const stateStore = createMemoryMobileRemoteControlStateStore();
    const runtime = createRuntime({ stateStore });
    try {
      const first = await runtime.service.start();
      const stopped = await runtime.service.stop();
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.enabled, false);
      assert.equal(stopped.accessUrl, undefined);
      assert.equal((await runtime.service.stop()).state, "stopped");

      // 停止只改用户意图，端口与 token 都必须留在盘上。
      const persisted = await stateStore.read();
      assert.equal(persisted?.enabled, false);
      assert.equal(persisted?.port, first.port);
      assert.equal(persisted?.token, tokenOf(first.accessUrl));

      const restarted = await runtime.service.start();
      assert.equal(restarted.state, "running");
      assert.equal(restarted.port, first.port);
      assert.equal(restarted.accessUrl, first.accessUrl);
    } finally {
      runtime.dispose();
    }
  });

  it("窗口销毁（suspend）收回监听但保留用户意图", async () => {
    const stateStore = createMemoryMobileRemoteControlStateStore();
    const runtime = createRuntime({ stateStore });
    try {
      const started = await runtime.service.start();
      const port = started.port;
      assert.ok(port);

      await runtime.suspend();

      // 状态必须回落：Host 进程被复用后不能让人看到"running 但端口没人听"。
      const status = await runtime.service.getStatus();
      assert.equal(status.state, "stopped");
      assert.equal(status.enabled, true);
      assert.equal(status.accessUrl, undefined);
      // 落盘的用户意图不变，下次启动才有东西可恢复。
      assert.equal((await stateStore.read())?.enabled, true);
      // 监听确实收回了。必须打 loopback：accessUrl 用的是真实局域网 IP，本机到某些虚拟网卡
      // 地址的连接会 SYN 重试而不是立刻 ECONNREFUSED，断言会一直挂着。
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/server-info`));
    } finally {
      runtime.dispose();
    }
  });

  it("重启后按落盘状态自动恢复，端口与 token 不变", async () => {
    const stateStore = createMemoryMobileRemoteControlStateStore();
    const first = createRuntime({ stateStore });
    const started = await first.service.start({ workspacePath: "/tmp/demo-project" });
    assert.equal(started.state, "running");
    await first.suspend();

    const second = createRuntime({ stateStore });
    try {
      await second.resumeIfEnabled({ workspacePath: "/tmp/demo-project" });
      const resumed = await second.service.getStatus();
      assert.equal(resumed.state, "running");
      assert.equal(resumed.enabled, true);
      assert.equal(resumed.port, started.port);
      // 手机端链接完全不变：端口与 token 都沿用落盘值。
      assert.equal(resumed.accessUrl, started.accessUrl);
    } finally {
      second.dispose();
    }
  });

  it("未开启过时不自动恢复", async () => {
    const runtime = createRuntime();
    try {
      await runtime.resumeIfEnabled({ workspacePath: "/tmp/demo-project" });
      const status = await runtime.service.getStatus();
      assert.equal(status.state, "stopped");
      assert.equal(status.enabled, false);
    } finally {
      runtime.dispose();
    }
  });

  it("自动恢复失败时保留用户意图，可在修好后重试", async () => {
    const stateStore = createMemoryMobileRemoteControlStateStore({
      enabled: true,
      token: "persisted-token",
    });
    const broken = createRuntime({ webRoot: join(webRoot, "does-not-exist"), stateStore });
    try {
      await broken.resumeIfEnabled({ workspacePath: "/tmp/demo-project" });
      const status = await broken.service.getStatus();
      assert.equal(status.state, "error");
      assert.equal(status.errorCode, "web-root-missing");
      assert.equal(status.enabled, true);
    } finally {
      broken.dispose();
    }

    // web 产物补上后（同一份落盘状态）：重试即可恢复，token 仍是原值。
    const fixed = createRuntime({ stateStore });
    try {
      const status = await fixed.service.start({ workspacePath: "/tmp/demo-project" });
      assert.equal(status.state, "running");
      assert.equal(tokenOf(status.accessUrl), "persisted-token");
    } finally {
      fixed.dispose();
    }
  });

  it("固定端口被占用时本次让位，但不覆盖落盘端口", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "0.0.0.0", () => resolve()));
    const blockedPort = (blocker.address() as AddressInfo).port;
    const stateStore = createMemoryMobileRemoteControlStateStore({
      enabled: true,
      port: blockedPort,
      token: "persisted-token",
    });
    const runtime = createRuntime({ stateStore });
    try {
      const status = await runtime.service.start();
      assert.equal(status.state, "running");
      assert.notEqual(status.port, blockedPort);
      // 占用者走了要能回到原端口，所以落盘值不能被临时让位结果覆盖。
      assert.equal((await stateStore.read())?.port, blockedPort);
      assert.equal(tokenOf(status.accessUrl), "persisted-token");
    } finally {
      runtime.dispose();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("手机连接计入 connectedClients，断开后归零", async () => {
    const runtime = createRuntime();
    let socket: WebSocket | undefined;
    try {
      const status = await runtime.service.start();
      assert.equal(status.state, "running");
      const url = status.accessUrl;
      assert.ok(url);
      const token = tokenOf(url);
      const port = status.port;
      assert.ok(port);

      socket = await connectWebSocket(`ws://127.0.0.1:${port}/ws`, token);
      const connected = await waitForStatus(runtime, (s) => s.connectedClients === 1);
      assert.equal(connected.state, "running");
      assert.equal(connected.connectedClients, 1);

      socket.close();
      socket = undefined;
      const disconnected = await waitForStatus(runtime, (s) => s.connectedClients === 0);
      assert.equal(disconnected.connectedClients, 0);
    } finally {
      socket?.close();
      runtime.dispose();
    }
  });

  it("stop 会主动断开已连接手机并收回监听", async () => {
    const runtime = createRuntime();
    let socket: WebSocket | undefined;
    try {
      const status = await runtime.service.start();
      const accessUrl = status.accessUrl;
      assert.ok(accessUrl);
      const token = tokenOf(accessUrl);
      const port = status.port;
      assert.ok(port);
      socket = await connectWebSocket(`ws://127.0.0.1:${port}/ws`, token);
      await waitForStatus(runtime, (s) => s.connectedClients === 1);

      const stopped = await runtime.service.stop();
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.connectedClients, 0);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/server-info`));
    } finally {
      socket?.close();
      runtime.dispose();
    }
  });

  it("resetToken 运行中换 token：同端口、旧 token 立即失效", async () => {
    const stateStore = createMemoryMobileRemoteControlStateStore();
    const runtime = createRuntime({ stateStore });
    try {
      const before = await runtime.service.start();
      const beforeToken = tokenOf(before.accessUrl);
      const port = before.port;
      assert.ok(port);

      const rotated = await runtime.service.resetToken();
      assert.equal(rotated.state, "running");
      assert.equal(rotated.enabled, true);
      // token 变了，端口没变：手机收藏的地址只需换 token 部分。
      assert.equal(rotated.port, port);
      const afterToken = tokenOf(rotated.accessUrl);
      assert.notEqual(afterToken, beforeToken);
      assert.equal((await stateStore.read())?.token, afterToken);

      const oldLink = await fetch(`http://127.0.0.1:${port}/api/server-info?token=${beforeToken}`);
      assert.equal(oldLink.status, 401);
      const newLink = await fetch(`http://127.0.0.1:${port}/api/server-info?token=${afterToken}`);
      assert.equal(newLink.status, 200);
    } finally {
      runtime.dispose();
    }
  });

  it("resetToken 未运行时只落盘，下次开启用新 token", async () => {
    const stateStore = createMemoryMobileRemoteControlStateStore();
    const runtime = createRuntime({ stateStore });
    try {
      const started = await runtime.service.start();
      const oldToken = tokenOf(started.accessUrl);
      const port = started.port;
      await runtime.service.stop();

      const rotated = await runtime.service.resetToken();
      assert.equal(rotated.state, "stopped");
      assert.equal(rotated.enabled, false);

      const restarted = await runtime.service.start();
      assert.equal(restarted.port, port);
      assert.notEqual(tokenOf(restarted.accessUrl), oldToken);
    } finally {
      runtime.dispose();
    }
  });
});
