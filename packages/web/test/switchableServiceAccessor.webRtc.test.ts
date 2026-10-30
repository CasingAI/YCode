import assert from "node:assert/strict";
import test from "node:test";
import {
  connectViaWebRtcManaged,
  type RtcPeerConnectionLike,
  type WebSocketConnection,
  type WebSocketConnectionSnapshot,
} from "@zcode/client";
import {
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  createDataChannelSocket,
  type DataChannelTransport,
  type Event,
  type IServerChannel,
  type ISocket,
} from "@zcode/rpc";
import {
  getServiceAccessorConnection,
  isCommandNotSentError,
  ServiceChannels,
  type FileEntry,
} from "@zcode/shared";
import { createSwitchableServiceAccessor } from "../src/connection/switchableServiceAccessor.js";

/**
 * 独立进程内的集成回归：真实 RPC ChannelServer + 真实 connectViaWebRtcManaged
 * + Web facade。只验证传输切换后的逻辑连续性，不启动任何 UI。
 */

type WebServices = NonNullable<WebSocketConnectionSnapshot["services"]>;
type SnapshotWithContinuity = WebSocketConnectionSnapshot & {
  readonly continuityGeneration?: number;
};
type FileParams = { path: string; includeHidden?: boolean };
type WriteTextFileParams = { path: string; content: string };
type BroadcastMessage = { channel: string; payload: unknown };

const RTC_ID = "11111111-1111-4111-8111-111111111111";
const ANSWER = JSON.stringify({ version: 1, type: "answer", sdp: "v=0\r\nfake-answer" });

function entry(name: string): FileEntry {
  return { name, path: `/ws/${name}`, type: "file" };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushTwice(): Promise<void> {
  await flush();
  await flush();
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
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

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(data);
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.dispatch("send", { data: bytes });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", { code: 1000, reason: "", wasClean: true });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  receive(bytes: Uint8Array): void {
    this.dispatch("message", { data: bytes.slice().buffer });
  }

  receiveBinary(bytes: Uint8Array): void {
    this.dispatch("message", { data: bytes.slice().buffer });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeDataChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly label: string) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("data channel is not open");
    this.dispatch("send", { data: data.slice() });
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatch("close", {});
  }

  open(): void {
    this.readyState = "open";
    this.dispatch("open", {});
  }

  receive(bytes: Uint8Array): void {
    this.dispatch("message", { data: bytes.slice().buffer });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState = "new";
  iceGatheringState = "new";
  localDescription: { type: string; sdp?: string } | null = null;
  remoteDescription: { type: "answer"; sdp: string } | null = null;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  onicegatheringstatechange: ((event: unknown) => void) | null = null;
  readonly channels: FakeDataChannel[] = [];

  constructor(readonly config: unknown) {
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "v=0\r\nfake-offer" };
  }

  async setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { ...description };
  }

  async setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void> {
    this.remoteDescription = description;
  }

  completeIce(): void {
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.({});
  }

  close(): void {
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    this.onconnectionstatechange?.({});
  }
}

interface FileResponder {
  readdir?: (params: FileParams) => Promise<FileEntry[]> | FileEntry[];
  writeTextFile?: (params: WriteTextFileParams) => Promise<void> | void;
}

interface AttachedServer {
  readonly calls: { readdir: number; writeTextFile: number };
  broadcast(message: BroadcastMessage): void;
  dispose(): void;
}

function attachServer(
  write: (bytes: Uint8Array) => void,
  registerSend: (listener: (bytes: Uint8Array) => void) => void,
  responder: FileResponder,
): AttachedServer {
  const incoming = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  const broadcastEmitter = new Emitter<BroadcastMessage>();
  const calls = { readdir: 0, writeTextFile: 0 };

  const socket: ISocket = {
    onData: incoming.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer) {
      write(buffer.buffer);
    },
    end() {},
    drain: () => Promise.resolve(),
    dispose() {},
  };
  registerSend((bytes) => incoming.fire(VSBuffer.wrap(bytes)));

  const server = new ChannelServer<undefined>(new SocketProtocol(socket), undefined, 30_000);
  const channel: IServerChannel<undefined> = {
    call: async (_ctx, command, args) => {
      const params = (args ?? [])[0] as FileParams & WriteTextFileParams;
      if (command === "readdir") {
        calls.readdir += 1;
        return responder.readdir ? responder.readdir(params) : [];
      }
      if (command === "writeTextFile") {
        calls.writeTextFile += 1;
        return responder.writeTextFile ? responder.writeTextFile(params) : undefined;
      }
      throw new Error(`unexpected file command: ${command}`);
    },
    listen: (_ctx, event) => {
      if (event === "onMessage") return broadcastEmitter.event as Event<unknown>;
      throw new Error(`unexpected broadcast event: ${event}`);
    },
  };
  server.registerChannel(ServiceChannels.File, channel);
  server.registerChannel(ServiceChannels.Broadcast, channel);

  return {
    calls,
    broadcast: (message) => broadcastEmitter.fire(message),
    dispose: () => {
      server.dispose();
      broadcastEmitter.dispose();
      incoming.dispose();
      onClose.dispose();
      onEnd.dispose();
    },
  };
}

function attachFallbackServer(socket: FakeWebSocket, responder: FileResponder): AttachedServer {
  return attachServer(
    (bytes) => socket.receive(bytes),
    (listener) => {
      socket.addEventListener("send", (event) => {
        const data = (event as { data: string | Uint8Array }).data;
        listener(typeof data === "string" ? new TextEncoder().encode(data) : data);
      });
    },
    responder,
  );
}

function attachRtcServer(channel: FakeDataChannel, responder: FileResponder): AttachedServer {
  return attachServer(
    (bytes) => channel.receive(bytes),
    (listener) => {
      channel.addEventListener("send", (event) => listener((event as { data: Uint8Array }).data));
    },
    responder,
  );
}

function isSignalSocket(socket: FakeWebSocket): boolean {
  return new URL(socket.url).pathname === "/ws/rtc";
}

interface FacadeHarness {
  readonly accessor: ReturnType<typeof createSwitchableServiceAccessor>;
  dispose(): void;
}

function attachFacade(connection: WebSocketConnection): FacadeHarness {
  const accessor = createSwitchableServiceAccessor();
  const apply = (): void => {
    const snapshot = connection.getSnapshot() as SnapshotWithContinuity;
    accessor.setTarget(snapshot.services, snapshot.generation, snapshot.continuityGeneration);
  };
  const unsubscribe = connection.subscribe(apply);
  apply();
  return {
    accessor,
    dispose: () => {
      unsubscribe();
      accessor.dispose();
    },
  };
}

interface Harness {
  readonly connection: WebSocketConnection;
  readonly fallback: FakeWebSocket;
  readonly fallbackServer: AttachedServer;
  readonly facade: FacadeHarness;
  readonly fallbackServices: WebServices;
  readonly signal: FakeWebSocket | undefined;
  readonly responder: FileResponder;
  readonly servers: AttachedServer[];
  snapshot(): SnapshotWithContinuity;
  dispose(): void;
}

async function boot(options: { rtc: boolean; responder?: FileResponder }): Promise<Harness> {
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  const responder = options.responder ?? {};
  const pending = connectViaWebRtcManaged("ws://test/ws", {
    initializeTimeoutMs: 2_000,
    negotiationTimeoutMs: 2_000,
    retryDelaysMs: [0],
    trafficPublishIntervalMs: 0,
    signalingHeartbeatMs: 60_000,
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    ...(options.rtc
      ? {
          peerConnectionFactory: (config) =>
            new FakePeerConnection(config) as unknown as RtcPeerConnectionLike,
          dataChannelSocketFactory: (transport: DataChannelTransport) =>
            createDataChannelSocket(transport),
          rtcIdFactory: () => RTC_ID,
        }
      : {}),
  });

  const fallback = FakeWebSocket.instances.find((socket) => !isSignalSocket(socket));
  assert.ok(fallback, "fallback WebSocket should be created");
  fallback.open();
  const fallbackServer = attachFallbackServer(fallback, responder);
  const connection = await pending;
  const snapshot = connection.getSnapshot() as SnapshotWithContinuity;
  assert.equal(snapshot.status, "connected");
  assert.ok(snapshot.services);
  const signal = FakeWebSocket.instances.find(isSignalSocket);
  const facade = attachFacade(connection);
  const servers = [fallbackServer];
  const harness: Harness = {
    connection,
    fallback,
    fallbackServer,
    facade,
    fallbackServices: snapshot.services,
    signal,
    responder,
    servers,
    snapshot: () => connection.getSnapshot() as SnapshotWithContinuity,
    dispose: () => {
      facade.dispose();
      connection.dispose();
      for (const server of servers) server.dispose();
    },
  };
  return harness;
}

async function upgradeRtc(
  harness: Harness,
  responder: FileResponder,
): Promise<{ peer: FakePeerConnection; channel: FakeDataChannel; server: AttachedServer }> {
  assert.ok(harness.signal, "signaling WebSocket should exist");
  harness.signal.open();
  await flush();
  const peer = FakePeerConnection.instances[0];
  assert.ok(peer, "peer should be created");
  const channel = peer.channels[0];
  assert.ok(channel, "data channel should be created");

  peer.completeIce();
  await flush();
  const server = attachRtcServer(channel, responder);
  harness.servers.push(server);
  harness.signal.receiveBinary(new TextEncoder().encode(ANSWER));
  await flush();
  channel.open();
  await waitFor(
    () =>
      harness.snapshot().services !== null &&
      harness.snapshot().services !== harness.fallbackServices &&
      harness.snapshot().status === "connected",
    "RTC services to become active",
  );
  return { peer, channel, server };
}

test("同连续性 WSS→RTC：在途 WSS 读取仍交付，新读取只走 RTC", async () => {
  const wssRead = deferred<FileEntry[]>();
  let fallbackReads = 0;
  const harness = await boot({
    rtc: true,
    responder: {
      readdir: () => {
        fallbackReads += 1;
        return wssRead.promise;
      },
    },
  });
  try {
    const before = harness.snapshot();
    assert.equal(before.services, harness.fallbackServices);

    const pending = harness.facade.accessor.services.fileService.readdir({ path: "/wss" });
    await waitFor(() => fallbackReads === 1, "WSS read to reach server");

    const rtcEntries = [entry("rtc.txt")];
    const { server: rtcServer } = await upgradeRtc(harness, {
      readdir: () => rtcEntries,
    });
    const afterSwitch = harness.snapshot();
    assert.equal(afterSwitch.status, "connected");
    assert.notEqual(afterSwitch.services, harness.fallbackServices);
    assert.equal(
      afterSwitch.continuityGeneration,
      before.continuityGeneration,
      "physical WSS→RTC switch must not change logical continuity",
    );

    // 旧 WSS 成功响应发生在切换前，但逻辑连接未断；必须交付而不是以旧代拒绝。
    wssRead.resolve([entry("wss.txt")]);
    assert.deepEqual(await pending, [entry("wss.txt")]);

    // 新读取只走 RTC 一次，不落到仍存活的 WSS。
    assert.deepEqual(
      await harness.facade.accessor.services.fileService.readdir({ path: "/rtc" }),
      rtcEntries,
    );
    assert.equal(rtcServer.calls.readdir, 1);
    assert.equal(fallbackReads, 1);
  } finally {
    harness.dispose();
  }
});

test("RTC 失效回到存活 WSS：连续性不变，新读取成功", async () => {
  let fallbackReads = 0;
  const wssEntries = [entry("wss.txt")];
  const harness = await boot({
    rtc: true,
    responder: {
      readdir: () => {
        fallbackReads += 1;
        return wssEntries;
      },
    },
  });
  try {
    const before = harness.snapshot();
    const { channel, server: rtcServer } = await upgradeRtc(harness, { readdir: () => [] });
    const whileRtc = harness.snapshot();
    assert.equal(
      whileRtc.continuityGeneration,
      before.continuityGeneration,
      "RTC takeover keeps the same logical continuity",
    );

    // 物理 RTC 通道失效；fallback WSS 仍然存活。
    channel.close();
    await waitFor(
      () =>
        harness.snapshot().services === harness.fallbackServices &&
        harness.snapshot().status === "connected",
      "fallback WSS to become active again",
    );
    const afterFail = harness.snapshot();
    assert.notEqual(afterFail.generation, whileRtc.generation, "physical generation must advance");
    assert.equal(
      afterFail.continuityGeneration,
      whileRtc.continuityGeneration,
      "RTC failure back to a live WSS keeps continuity",
    );

    assert.deepEqual(
      await harness.facade.accessor.services.fileService.readdir({ path: "/back" }),
      wssEntries,
    );
    assert.equal(fallbackReads, 1);
    assert.equal(rtcServer.calls.readdir, 0);
  } finally {
    harness.dispose();
  }
});

test("WSS 真实断开：断线调用 not-sent，重连后旧逻辑结果被拒绝", async () => {
  let fallbackReads = 0;
  const firstRead = deferred<FileEntry[]>();
  const harness = await boot({
    rtc: false,
    responder: {
      readdir: () => {
        fallbackReads += 1;
        return fallbackReads === 1 ? firstRead.promise : [entry("reconnected.txt")];
      },
    },
  });
  const usedFallbacks = new Set<FakeWebSocket>([harness.fallback]);
  try {
    const before = harness.snapshot();
    const pending = harness.facade.accessor.services.fileService.readdir({
      path: "/before-disconnect",
    });
    // 先挂接失败分支：断线会立即以 ConnectionClosed 拒绝在途调用，不能留成未处理 rejection。
    const pendingOutcome = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, error }),
    );
    await waitFor(() => fallbackReads === 1, "WSS read to reach server");

    harness.fallback.close();
    await waitFor(
      () => harness.snapshot().services === null,
      "facade target to clear on disconnect",
    );
    assert.equal(harness.snapshot().status, "reconnecting");

    await assert.rejects(
      harness.facade.accessor.services.fileService.readdir({ path: "/while-down" }),
      (error: Error) => error.name === "ConnectionClosed" && isCommandNotSentError(error),
    );

    await waitFor(
      () =>
        FakeWebSocket.instances.some(
          (socket) => !isSignalSocket(socket) && !usedFallbacks.has(socket),
        ),
      "new fallback socket after backoff",
    );
    const nextFallback = FakeWebSocket.instances.find(
      (socket) => !isSignalSocket(socket) && !usedFallbacks.has(socket),
    );
    assert.ok(nextFallback);
    usedFallbacks.add(nextFallback);
    nextFallback.open();
    harness.servers.push(attachFallbackServer(nextFallback, harness.responder));
    await waitFor(
      () => harness.snapshot().services !== null && harness.snapshot().status === "connected",
      "managed WSS to reconnect",
    );
    const reconnected = harness.snapshot();
    assert.notEqual(
      reconnected.continuityGeneration,
      before.continuityGeneration,
      "real reconnect starts a new logical continuity",
    );

    // 旧逻辑连接上的结果即使此时才返回，也不能交给重连后的页面。
    firstRead.resolve([entry("late-old.txt")]);
    const outcome = await pendingOutcome;
    assert.equal(outcome.ok, false, "old logical result must not be delivered after reconnect");
    if (!outcome.ok) assert.equal(outcome.error.name, "ConnectionClosed");
  } finally {
    harness.dispose();
  }
});

test("同连续性切换中在途 mutation 只上行一次，不重放", async () => {
  const mutation = deferred<void>();
  let wssWrites = 0;
  const harness = await boot({
    rtc: true,
    responder: {
      writeTextFile: () => {
        wssWrites += 1;
        return mutation.promise;
      },
    },
  });
  try {
    const pending = harness.facade.accessor.services.fileService.writeTextFile({
      path: "/wss.txt",
      content: "x",
    });
    await waitFor(() => wssWrites === 1, "mutation to reach WSS");

    const { server: rtcServer } = await upgradeRtc(harness, {
      writeTextFile: () => {
        throw new Error("mutation must not be replayed on RTC");
      },
    });

    mutation.resolve();
    await pending;
    assert.equal(wssWrites, 1, "mutation is sent exactly once on the original transport");
    assert.equal(rtcServer.calls.writeTextFile, 0, "mutation must not be replayed");
  } finally {
    harness.dispose();
  }
});

test("WSS→RTC 物理 attachment 换代通知，旧 WSS 事件被拦截", async () => {
  const harness = await boot({ rtc: true });
  try {
    const connectionPort = getServiceAccessorConnection(
      harness.facade.accessor.services.zcodeAgentService,
    );
    assert.ok(connectionPort);
    assert.equal(connectionPort.getAttachment(), harness.fallbackServices.zcodeAgentService);
    const notifications: Array<object | null> = [];
    const unsubscribe = connectionPort.subscribe(() =>
      notifications.push(connectionPort.getAttachment()),
    );

    const facadeServices = harness.facade.accessor.services;
    const received: string[] = [];
    harness.facade.accessor.services.broadcastService.onMessage((message) =>
      received.push(String((message as BroadcastMessage).payload)),
    );
    await flushTwice();
    harness.fallbackServer.broadcast({ channel: "state:test", payload: "wss-before" });
    await waitFor(() => received.length === 1, "WSS event to arrive");

    const { server: rtcServer } = await upgradeRtc(harness, {});
    const rtcServices = harness.snapshot().services;
    assert.ok(rtcServices);
    assert.equal(connectionPort.getAttachment(), rtcServices.zcodeAgentService);
    assert.deepEqual(notifications, [rtcServices.zcodeAgentService]);
    assert.equal(
      harness.facade.accessor.services,
      facadeServices,
      "facade identity stays stable across physical attachment replacement",
    );

    await flushTwice();
    rtcServer.broadcast({ channel: "state:test", payload: "rtc-after" });
    await waitFor(() => received.length === 2, "RTC event to arrive");

    // 旧物理通道的迟到事件不得进入当前逻辑订阅。
    harness.fallbackServer.broadcast({ channel: "state:test", payload: "wss-late" });
    await flushTwice();
    assert.deepEqual(received, ["wss-before", "rtc-after"]);

    unsubscribe();
  } finally {
    harness.dispose();
  }
});
