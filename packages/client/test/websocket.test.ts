import assert from "node:assert/strict";
import test from "node:test";
import { ChannelServer, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { ISettingService } from "@zcode/services";
import { connectViaWebSocketManaged, type WebSocketConnection } from "../src/websocket.js";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.dispatch("send", { data: bytes.slice().buffer });
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: 1000, reason: "", wasClean: true });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  receive(bytes: Uint8Array): void {
    const copy = bytes.slice().buffer;
    this.dispatch("message", { data: copy });
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? new Set<() => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function installFakeWebSocket(): () => void {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeWebSocket.instances = [];
  return () => {
    globalThis.WebSocket = previous;
    FakeWebSocket.instances = [];
  };
}

interface FakeBrowser {
  readonly window: FakeEventTarget;
  /** 修改 visibilityState 后派发 visibilitychange，模拟浏览器切前后台。 */
  setVisibility(state: string): void;
  restore(): void;
}

function installFakeBrowser(): FakeBrowser {
  const scope = globalThis as typeof globalThis & { window?: unknown; document?: unknown };
  const previousWindow = scope.window;
  const previousDocument = scope.document;
  const browser = new FakeEventTarget();
  const doc: { visibilityState: string } = { visibilityState: "visible" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return {
    window: browser,
    setVisibility(state: string) {
      doc.visibilityState = state;
      browser.dispatch("visibilitychange");
    },
    restore() {
      if (previousWindow === undefined) delete scope.window;
      else
        Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      if (previousDocument === undefined) delete scope.document;
      else
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
        });
    },
  };
}

interface AttachServerOptions {
  /** 设置后 handler 完成前推进服务端单调时钟，使响应携带合法 metadata。 */
  serverProcessingMs?: number;
  /** 让真实总耗时大于服务端处理耗时，避免 fake 传输下被判定为非法样本。 */
  handlerDelayMs?: number;
  /** 只对前 N 次调用生成 metadata；之后的响应模拟服务端未提供计时。 */
  metadataCallLimit?: number;
}

function attachServer(
  socket: FakeWebSocket,
  options: AttachServerOptions = {},
): ChannelServer<string> {
  const incoming = new Emitter<VSBuffer>();
  const serverSocket: ISocket = {
    onData: incoming.event,
    onClose: new Emitter<void>().event,
    onEnd: new Emitter<void>().event,
    write(buffer) {
      socket.receive(buffer.buffer);
    },
    end() {
      socket.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      socket.close();
    },
  };
  const protocol = new SocketProtocol(serverSocket);
  let serverNow = 0;
  let callCount = 0;
  const server = new ChannelServer(protocol, "test", undefined, undefined, {
    now: () => serverNow,
  });
  server.registerChannel(ISettingService.channelName, {
    call: async () => {
      if (options.serverProcessingMs === undefined) {
        return new Promise(() => {});
      }
      if (options.handlerDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.handlerDelayMs));
      }
      callCount += 1;
      if (options.metadataCallLimit !== undefined && callCount > options.metadataCallLimit) {
        // 时钟回退让服务端 elapsed 为负，从而省略 metadata（0 仍是合法样本）。
        serverNow = -1;
        return undefined;
      }
      serverNow += options.serverProcessingMs * callCount;
      return undefined;
    },
  });
  socket.addEventListener("send", (event) => {
    const data = (event as { data: ArrayBuffer }).data;
    incoming.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  return server;
}

async function openConnection(
  options: {
    serverProcessingMs?: number;
    handlerDelayMs?: number;
    latencyStaleMs?: number;
    trafficPublishIntervalMs?: number;
    metadataCallLimit?: number;
    timers?: Pick<ReturnType<typeof createManualTimers>, "now" | "setTimeout" | "clearTimeout">;
  } = {},
): Promise<{
  connection: WebSocketConnection;
  socket: FakeWebSocket;
}> {
  const pending = connectViaWebSocketManaged("ws://test", {
    initializeTimeoutMs: 1_000,
    retryDelaysMs: [0, 0, 0],
    trafficPublishIntervalMs: options.trafficPublishIntervalMs ?? 0,
    latencyStaleMs: options.latencyStaleMs,
    now: options.timers?.now,
    setTimeout: options.timers?.setTimeout,
    clearTimeout: options.timers?.clearTimeout,
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  });
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.open();
  attachServer(socket, {
    serverProcessingMs: options.serverProcessingMs,
    handlerDelayMs: options.handlerDelayMs,
    metadataCallLimit: options.metadataCallLimit,
  });
  return { connection: await pending, socket };
}

function waitFor(milliseconds = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 可手动推进的计时器，避免真实等待导致过期边界抖动。 */
function createManualTimers(options: { leakCleared?: boolean } = {}): {
  now: () => number;
  setTimeout: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  /** 记录所有调度过的时长，用于断言没有额外新增过期计时。 */
  scheduled: number[];
  advance: (milliseconds: number) => void;
} {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  const scheduled: number[] = [];
  return {
    now: () => current,
    scheduled,
    setTimeout: (handler, timeoutMs) => {
      scheduled.push(timeoutMs);
      const id = nextId++;
      timers.set(id, { at: current + timeoutMs, handler });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      // 模拟底层调度器丢弃 clearTimeout：已清理的计时器仍会被执行。
      if (options.leakCleared) return;
      timers.delete(Number(handle));
    },
    advance: (milliseconds) => {
      current += milliseconds;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at > current) continue;
          timers.delete(id);
          timer.handler();
          fired = true;
          break;
        }
      }
    },
  };
}

test("managed WebSocket 在 Initialize ready 后提供 services，断线会 fail-closed 并重连", async () => {
  const restore = installFakeWebSocket();
  try {
    const first = await openConnection();
    assert.equal(first.connection.getSnapshot().status, "connected");
    assert.equal(first.connection.getSnapshot().generation, 1);
    const firstServices = first.connection.getSnapshot().services;
    assert.ok(firstServices);

    const pending = firstServices.settingService.get();
    await waitFor();
    assert.ok(
      (first.connection.getSnapshot().traffic?.sentBytes ?? 0) > 0,
      "Initialize 后应累计发送 RPC payload 字节",
    );
    const sentBeforeReconnect = first.connection.getSnapshot().traffic?.sentBytes ?? 0;
    const receivedBeforeReconnect = first.connection.getSnapshot().traffic?.receivedBytes ?? 0;
    first.socket.close();
    assert.equal(first.connection.getSnapshot().status, "reconnecting");
    assert.equal(first.connection.getSnapshot().attempt, 1);
    await assert.rejects(pending, (error: Error) => error.name === "ConnectionClosed");

    await waitFor();
    const secondSocket = FakeWebSocket.instances[1];
    assert.ok(secondSocket);
    secondSocket.open();
    attachServer(secondSocket);
    await waitFor();
    assert.equal(first.connection.getSnapshot().status, "connected");
    assert.equal(first.connection.getSnapshot().generation, 2);
    assert.notEqual(first.connection.getSnapshot().services, firstServices);
    assert.ok((first.connection.getSnapshot().traffic?.sentBytes ?? 0) >= sentBeforeReconnect);
    assert.ok(
      (first.connection.getSnapshot().traffic?.receivedBytes ?? 0) >= receivedBeforeReconnect,
    );
    first.connection.dispose();
  } finally {
    restore();
  }
});

test("真实断线立即更换 continuity，即使物理 generation 尚未递增", async () => {
  const restore = installFakeWebSocket();
  let connection: WebSocketConnection | null = null;
  try {
    const opened = await openConnection();
    connection = opened.connection;
    const connected = connection.getSnapshot();
    assert.equal(typeof connected.continuityGeneration, "number");

    opened.socket.close();
    const disconnected = connection.getSnapshot();
    // 物理 target/generation 只在换代时递增；断线时必须单独使逻辑连接失效。
    assert.equal(disconnected.generation, connected.generation);
    assert.equal(disconnected.services, null);
    assert.notEqual(disconnected.continuityGeneration, connected.continuityGeneration);

    await waitFor();
    const secondSocket = FakeWebSocket.instances[1];
    assert.ok(secondSocket);
    secondSocket.open();
    attachServer(secondSocket);
    await waitFor();

    const reconnected = connection.getSnapshot();
    assert.equal(reconnected.status, "connected");
    assert.ok(reconnected.services);
    // 重连属于新的逻辑连接，不得复用断线前或断线时的 token。
    assert.notEqual(reconnected.continuityGeneration, connected.continuityGeneration);
    assert.notEqual(reconnected.continuityGeneration, disconnected.continuityGeneration);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("流量更新合并期间不替换 services，dispose 立即发布最终累计值", async () => {
  const restore = installFakeWebSocket();
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [0],
      trafficPublishIntervalMs: 1_000,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    attachServer(socket);
    const connection = await pending;
    const before = connection.getSnapshot();
    const services = before.services;
    assert.ok(services);

    void services.settingService.get().catch(() => undefined);
    await waitFor(10);
    const during = connection.getSnapshot();
    // 载荷已经同步累计，但还没到合并发布时刻；services 与代次不能因流量变化而重建。
    assert.equal(during.services, before.services);
    assert.equal(during.generation, before.generation);

    connection.dispose();
    assert.ok((connection.getSnapshot().traffic?.sentBytes ?? 0) > 0);
  } finally {
    restore();
  }
});

test("短命重连不会把退避重置成 0 秒热循环，稳定连接才重置计数", async () => {
  const restore = installFakeWebSocket();
  let now = 0;
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [0, 0, 0],
      now: () => now,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    attachServer(first);
    const connection = await pending;

    first.close();
    assert.equal(connection.getSnapshot().attempt, 1);
    await waitFor();
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.open();
    attachServer(second);
    await waitFor();
    assert.equal(connection.getSnapshot().status, "connected");

    second.close();
    assert.equal(connection.getSnapshot().attempt, 2);
    await waitFor();
    now = 30_000;
    const third = FakeWebSocket.instances[2];
    assert.ok(third);
    third.open();
    attachServer(third);
    await waitFor();
    now = 60_001;
    third.close();
    assert.equal(connection.getSnapshot().attempt, 1);
    connection.dispose();
  } finally {
    restore();
  }
});

test("旧代 socket 的迟到 open 不会覆盖新代连接状态", async () => {
  const restore = installFakeWebSocket();
  try {
    const first = await openConnection();
    const oldSocket = first.socket;
    oldSocket.close();
    await waitFor();
    const secondSocket = FakeWebSocket.instances[1];
    assert.ok(secondSocket);
    secondSocket.open();
    attachServer(secondSocket);
    await waitFor();

    oldSocket.dispatch("open", {});
    assert.equal(first.connection.getSnapshot().status, "connected");
    assert.equal(first.connection.getSnapshot().generation, 2);
    assert.equal(FakeWebSocket.instances.length, 2);
    first.connection.dispose();
  } finally {
    restore();
  }
});

test("online/focus 事件会提前重试但不会创建并行连接", async () => {
  const restoreSocket = installFakeWebSocket();
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  const browser = new FakeEventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [1_000],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    attachServer(first);
    const connection = await pending;
    first.close();
    assert.equal(connection.getSnapshot().status, "reconnecting");

    browser.dispatch("online");
    browser.dispatch("focus");
    assert.equal(FakeWebSocket.instances.length, 2);
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.open();
    attachServer(second);
    await waitFor();
    assert.equal(connection.getSnapshot().status, "connected");
    connection.dispose();
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    restoreSocket();
  }
});

test("首次 WebSocket open 超时会回到 bootstrap error，不会静默重试", async () => {
  const restore = installFakeWebSocket();
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 5,
      retryDelaysMs: [0],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    await assert.rejects(pending);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    restore();
  }
});

test("首次 ChannelClient 初始化超时会回到 bootstrap error，不会静默重试", async () => {
  const restore = installFakeWebSocket();
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 5,
      retryDelaysMs: [0],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    await assert.rejects(pending);
    await waitFor(10);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    restore();
  }
});

test("同一代际的 error+close 只触发一次断线处理", async () => {
  const restore = installFakeWebSocket();
  try {
    let closeEvents = 0;
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [0],
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      onClose: () => {
        closeEvents += 1;
      },
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    attachServer(socket);
    const connection = await pending;
    socket.dispatch("error", {});
    socket.close();
    await waitFor();
    assert.equal(closeEvents, 1);
    connection.dispose();
  } finally {
    restore();
  }
});

test("dispose 会阻止后续重连", async () => {
  const restore = installFakeWebSocket();
  try {
    const { connection, socket } = await openConnection();
    connection.dispose();
    socket.close();
    await waitFor();
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(connection.getSnapshot().status, "closed");
  } finally {
    restore();
  }
});

test("隐藏超过阈值后回前台会无条件换代，即使快照仍是过期的 connected", async () => {
  const restoreSocket = installFakeWebSocket();
  const restoreBrowser = installFakeBrowser();
  let now = 0;
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [0],
      foregroundReconnectThresholdMs: 5_000,
      now: () => now,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    attachServer(first);
    const connection = await pending;
    assert.equal(connection.getSnapshot().status, "connected");

    restoreBrowser.setVisibility("hidden");
    now = 6_000;
    restoreBrowser.setVisibility("visible");

    // 快照此时还停在 connected，但那条 socket 早已在后台被系统掐掉，
    // 必须直接换代而不是被 retryNow 的 connected 早退吞掉。
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(first.readyState, FakeWebSocket.CLOSED);
    // 强制销毁带来的迟到 close 不能被当成又一次断线重复计数。
    assert.equal(connection.getSnapshot().attempt, 0);

    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.open();
    attachServer(second);
    await waitFor();
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().generation, 2);
    connection.dispose();
  } finally {
    restoreBrowser.restore();
    restoreSocket();
  }
});

test("隐藏未超过阈值时不重建连接，快照保持 connected", async () => {
  const restoreSocket = installFakeWebSocket();
  const restoreBrowser = installFakeBrowser();
  let now = 0;
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [0],
      foregroundReconnectThresholdMs: 5_000,
      now: () => now,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    attachServer(first);
    const connection = await pending;

    restoreBrowser.setVisibility("hidden");
    now = 2_000;
    restoreBrowser.setVisibility("visible");

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(first.readyState, FakeWebSocket.OPEN);
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().generation, 1);
    connection.dispose();
  } finally {
    restoreBrowser.restore();
    restoreSocket();
  }
});

test("锁屏后从 BFCache 恢复的 pageshow 走同一条强制重连路径", async () => {
  const restoreSocket = installFakeWebSocket();
  const restoreBrowser = installFakeBrowser();
  let now = 0;
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [0],
      foregroundReconnectThresholdMs: 5_000,
      now: () => now,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    attachServer(first);
    const connection = await pending;

    restoreBrowser.window.dispatch("pagehide");
    now = 9_000;
    restoreBrowser.window.dispatch("pageshow");
    assert.equal(FakeWebSocket.instances.length, 2);

    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.open();
    attachServer(second);
    await waitFor();
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().generation, 2);

    // 没有先隐藏过的 pageshow（如首次加载）拿不到隐藏时长，不能触发换代。
    restoreBrowser.window.dispatch("pageshow");
    assert.equal(FakeWebSocket.instances.length, 2);
    connection.dispose();
  } finally {
    restoreBrowser.restore();
    restoreSocket();
  }
});

test("退避期间 disconnectedAt 记录首次断线时刻，ready 后清空", async () => {
  const restoreSocket = installFakeWebSocket();
  const restoreBrowser = installFakeBrowser();
  let now = 0;
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [50],
      now: () => now,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    attachServer(first);
    const connection = await pending;
    assert.equal(connection.getSnapshot().disconnectedAt, null);

    now = 1_000;
    first.close();
    assert.equal(connection.getSnapshot().status, "reconnecting");
    assert.equal(connection.getSnapshot().disconnectedAt, 1_000);
    assert.equal(connection.getSnapshot().nextRetryAt, 1_050);

    // 再次尝试失败时不能把断线时刻刷新成「刚刚才断」，否则 UI 永远等不到升级。
    now = 1_100;
    await waitFor(80);
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.dispatch("error", {});
    assert.equal(connection.getSnapshot().disconnectedAt, 1_000);

    now = 1_200;
    await waitFor(80);
    const third = FakeWebSocket.instances[2];
    assert.ok(third);
    third.open();
    attachServer(third);
    await waitFor();
    assert.equal(connection.getSnapshot().status, "connected");
    assert.equal(connection.getSnapshot().disconnectedAt, null);
    connection.dispose();
  } finally {
    restoreBrowser.restore();
    restoreSocket();
  }
});

test("managed WebSocket 始终发布 disabled 直连状态", async () => {
  const restore = installFakeWebSocket();
  try {
    const pending = connectViaWebSocketManaged(
      "ws://alice:secret@test:8443/socket?token=abc&rtcId=xyz&remote=1#frag",
      {
        initializeTimeoutMs: 1_000,
        retryDelaysMs: [0],
        trafficPublishIntervalMs: 0,
        webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      },
    );
    const first = FakeWebSocket.instances[0];
    assert.ok(first);
    first.open();
    attachServer(first);
    const connection = await pending;

    const expected = {
      transport: "websocket",
      directState: "disabled",
    };
    assert.deepEqual(connection.getSnapshot().connectionInfo, expected);
    // 服务端 Initialize 是 Regular RPC 载荷，接收量在握手完成时已有值；发送量要等首个业务调用。
    assert.equal(connection.getSnapshot().traffic?.sentBytes, 0);
    assert.ok((connection.getSnapshot().traffic?.receivedBytes ?? 0) > 0);
    const services = connection.getSnapshot().services;
    assert.ok(services);
    void services.settingService.get().catch(() => undefined);
    await waitFor(5);
    assert.ok((connection.getSnapshot().traffic?.sentBytes ?? 0) > 0);

    first.close();
    assert.equal(connection.getSnapshot().status, "reconnecting");
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: null,
      directState: "disabled",
    });

    await waitFor();
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    second.open();
    attachServer(second);
    await waitFor();
    assert.deepEqual(connection.getSnapshot().connectionInfo, expected);

    connection.dispose();
    assert.deepEqual(connection.getSnapshot().connectionInfo, {
      transport: null,
      directState: "disabled",
    });
  } finally {
    restore();
  }
});

test("业务 RPC 完成样本发布最近一次延迟，不改变 services/generation 且不新增帧", async () => {
  const restore = installFakeWebSocket();
  let connection: WebSocketConnection | undefined;
  try {
    const opened = await openConnection({
      serverProcessingMs: 2,
      handlerDelayMs: 10,
    });
    connection = opened.connection;
    const { socket } = opened;
    const before = connection.getSnapshot();
    const services = before.services;
    assert.ok(services);
    let sentFrames = 0;
    socket.addEventListener("send", () => {
      sentFrames += 1;
    });

    await services.settingService.get();
    await waitFor(20);

    const after = connection.getSnapshot();
    assert.ok(after.latency, "合法响应应发布延迟样本");
    assert.equal(after.latency?.serverProcessingMs, 2);
    assert.ok(Number.isFinite(after.latency?.networkRoundTripMs));
    assert.ok((after.latency?.networkRoundTripMs ?? -1) >= 0);
    assert.equal(sentFrames, 1, "采样不能增加请求帧");
    assert.equal(after.services, before.services);
    assert.equal(after.generation, before.generation);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("延迟样本复用流量合并发布，只保留最后一条", async () => {
  const restore = installFakeWebSocket();
  let connection: WebSocketConnection | undefined;
  try {
    connection = (
      await openConnection({
        serverProcessingMs: 2,
        handlerDelayMs: 20,
        trafficPublishIntervalMs: 250,
      })
    ).connection;
    const services = connection.getSnapshot().services;
    assert.ok(services);
    let notifications = 0;
    connection.subscribe(() => {
      notifications += 1;
    });

    await services.settingService.get();
    await services.settingService.get();
    await services.settingService.get();
    await waitFor(40);
    assert.equal(notifications, 0, "合并窗口内不能逐个样本发布");
    // 快照同步可读，但订阅通知仍只在合并窗口结束时触发一次。
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 6);

    await waitFor(300);
    assert.equal(notifications, 1, "多个样本只触发一次合并发布");
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 6);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("延迟样本过期立即清空并发布，不新增帧也不修改流量；新样本重置过期计时", async () => {
  const restore = installFakeWebSocket();
  const clock = createManualTimers();
  let connection: WebSocketConnection | undefined;
  try {
    const pending = connectViaWebSocketManaged("ws://test", {
      initializeTimeoutMs: 1_000,
      retryDelaysMs: [0],
      trafficPublishIntervalMs: 0,
      latencyStaleMs: 120,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket);
    socket.open();
    attachServer(socket, { serverProcessingMs: 2, handlerDelayMs: 10 });
    connection = await pending;
    const services = connection.getSnapshot().services;
    assert.ok(services);
    let sentFrames = 0;
    socket.addEventListener("send", () => {
      sentFrames += 1;
    });

    await services.settingService.get();
    clock.advance(0);
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 2);

    clock.advance(60);
    await services.settingService.get();
    clock.advance(0);
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 4);

    // 第一条约 120ms 的计时器已被新样本替换；此时只过去了 120ms。
    clock.advance(60);
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 4);
    const trafficBeforeExpiry = connection.getSnapshot().traffic;
    const framesBeforeExpiry = sentFrames;

    clock.advance(60);
    assert.equal(connection.getSnapshot().latency, undefined, "过期后应清空延迟");
    assert.deepEqual(connection.getSnapshot().traffic, trafficBeforeExpiry);
    assert.equal(sentFrames, framesBeforeExpiry, "过期清空不能产生网络帧");
  } finally {
    connection?.dispose();
    restore();
  }
});

test("延迟样本在合并通知前同步进入快照，非法 metadata 不覆盖也不刷新过期", async () => {
  const restore = installFakeWebSocket();
  const clock = createManualTimers();
  let connection: WebSocketConnection | undefined;
  try {
    const opened = await openConnection({
      serverProcessingMs: 2,
      handlerDelayMs: 10,
      latencyStaleMs: 200,
      trafficPublishIntervalMs: 100,
      metadataCallLimit: 1,
      timers: clock,
    });
    connection = opened.connection;
    const services = connection.getSnapshot().services;
    assert.ok(services);
    let notifications = 0;
    connection.subscribe(() => {
      notifications += 1;
    });

    await services.settingService.get();
    await waitFor(20);
    const first = connection.getSnapshot().latency;
    assert.ok(first, "合并通知前 getSnapshot 必须已能读到最新样本");
    assert.equal(first.serverProcessingMs, 2);
    assert.equal(notifications, 0, "样本变化仍只在合并窗口结束时通知订阅");

    clock.advance(100);
    assert.equal(notifications, 1, "普通流量发布不能新增样本通知");
    assert.equal(connection.getSnapshot().latency, first);

    // 服务端省略 metadata 的响应必须被忽略，既不覆盖样本也不重置过期计时。
    await services.settingService.get();
    await waitFor(20);
    assert.equal(connection.getSnapshot().latency, first);

    clock.advance(100);
    assert.equal(connection.getSnapshot().latency, undefined, "过期仍按首个样本计时");
  } finally {
    connection?.dispose();
    restore();
  }
});

test("过期计时器被替换后，迟到回调不能清除新样本", async () => {
  const restore = installFakeWebSocket();
  const clock = createManualTimers({ leakCleared: true });
  let connection: WebSocketConnection | undefined;
  try {
    const opened = await openConnection({
      serverProcessingMs: 2,
      handlerDelayMs: 10,
      latencyStaleMs: 50,
      timers: clock,
    });
    connection = opened.connection;
    const services = connection.getSnapshot().services;
    assert.ok(services);

    await services.settingService.get();
    await waitFor(20);
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 2);
    clock.advance(20);

    await services.settingService.get();
    await waitFor(20);
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 4);

    // 第一个计时器已被新样本替换，但调度器仍执行它：不能清除当前样本。
    clock.advance(30);
    assert.equal(connection.getSnapshot().latency?.serverProcessingMs, 4, "旧计时器不能清除新样本");

    clock.advance(20);
    assert.equal(connection.getSnapshot().latency, undefined);
  } finally {
    connection?.dispose();
    restore();
  }
});

test("重连进入新代立即清空延迟，旧样本不会回填，dispose 后保持无数据", async () => {
  const restore = installFakeWebSocket();
  let connection: WebSocketConnection | undefined;
  try {
    const first = await openConnection({ serverProcessingMs: 2, handlerDelayMs: 10 });
    connection = first.connection;
    const firstServices = first.connection.getSnapshot().services;
    assert.ok(firstServices);
    await firstServices.settingService.get();
    await waitFor(20);
    assert.equal(first.connection.getSnapshot().latency?.serverProcessingMs, 2);

    first.socket.close();
    assert.equal(first.connection.getSnapshot().status, "reconnecting");
    assert.equal(first.connection.getSnapshot().latency, undefined);

    await waitFor();
    const secondSocket = FakeWebSocket.instances[1];
    assert.ok(secondSocket);
    secondSocket.open();
    attachServer(secondSocket, { serverProcessingMs: 4, handlerDelayMs: 10 });
    await waitFor();
    assert.equal(first.connection.getSnapshot().status, "connected");
    assert.equal(first.connection.getSnapshot().latency, undefined, "新代不能继承旧样本");

    const secondServices = first.connection.getSnapshot().services;
    assert.ok(secondServices);
    await secondServices.settingService.get();
    await waitFor(20);
    assert.equal(first.connection.getSnapshot().latency?.serverProcessingMs, 4);

    first.connection.dispose();
    assert.equal(first.connection.getSnapshot().latency, undefined);
  } finally {
    connection?.dispose();
    restore();
  }
});
