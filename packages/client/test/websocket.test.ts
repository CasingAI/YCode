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

function attachServer(socket: FakeWebSocket): ChannelServer<string> {
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
  const server = new ChannelServer(protocol, "test");
  server.registerChannel(ISettingService.channelName, {
    call: () => new Promise(() => {}),
  });
  socket.addEventListener("send", (event) => {
    const data = (event as { data: ArrayBuffer }).data;
    incoming.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  return server;
}

async function openConnection(): Promise<{
  connection: WebSocketConnection;
  socket: FakeWebSocket;
}> {
  const pending = connectViaWebSocketManaged("ws://test", {
    initializeTimeoutMs: 1_000,
    retryDelaysMs: [0, 0, 0],
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  });
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.open();
  attachServer(socket);
  return { connection: await pending, socket };
}

function waitFor(milliseconds = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    first.connection.dispose();
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
